"""MorphoGem End-to-End VRM Auto-Rig + Separate Hair Attachment Exporter (Blender).

Reads an Assembly node from `project.mgem`, automatically separates hair parts
from body/head parts, decimates to realtime-friendly topology, builds a VRM 1.0 /
Unity Humanoid skeleton with anatomically isolated 4-bone weights on the bald
body+head, binds hair parts 100% to the `Head` bone (zero shoulder stretching),
and exports rigged FBX, GLB, and Blend (with optional Anime Cel-Toon shader).

Command:
  blender --background --factory-startup --disable-autoexec --python-exit-code 1 \
    --python scripts/export-rigged-vrm-graph.py -- INPUT.mgem OUTPUT_DIR [--assembly-node ID]
"""
import argparse
import importlib.util
import json
import re
import shutil
import sys
import zipfile
from math import radians
from pathlib import Path
import bpy
from mathutils import Matrix, Vector, Euler


SCRIPTS_DIR = Path(__file__).resolve().parent
HAIR_NAME_RE = re.compile(r'(头发|发饰|假发|刘海|hair|wig|bangs|ponytail|twintail)', re.I)


def load_sibling_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(SCRIPTS_DIR / filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def decimate_if_needed(mesh_obj, target_polys):
    n = len(mesh_obj.data.polygons)
    if n <= target_polys:
        return
    mod = mesh_obj.modifiers.new(name='DecimateRig', type='DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = max(0.005, float(target_polys) / float(n))
    mod.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.modifier_apply(modifier=mod.name)


def run(source_mgem, out_dir, assembly_node_id='', stage_only=False):
    export_mod = load_sibling_module('export_node_graph', 'export-node-graph.py')
    rig_mod = load_sibling_module('auto_rig_vrm', 'auto-rig-vrm.py')

    src = Path(source_mgem).resolve()
    out = Path(out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)

    extracted = out / 'unpacked_mgem'
    if extracted.exists():
        shutil.rmtree(extracted)
    extracted.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(src, 'r') as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            dest = (extracted / info.filename).resolve()
            root_str = str(extracted.resolve())
            if not (dest == extracted.resolve() or str(dest).startswith(root_str + '\\') or str(dest).startswith(root_str + '/')):
                raise ValueError(f'Unsafe archive path: {info.filename}')
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as r, open(dest, 'wb') as w:
                shutil.copyfileobj(r, w)

    project = json.loads((extracted / 'project.json').read_text(encoding='utf-8'))
    graph = project.get('nodeGraph') or {}
    nodes = {n['id']: n for n in (graph.get('nodes') or [])}
    edges = graph.get('edges') or []

    asm = nodes.get(assembly_node_id) if assembly_node_id else next((n for n in nodes.values() if n.get('type') == 'assembly_export'), None)
    if not asm:
        raise ValueError('No assembly_export node found in nodeGraph')

    mesh_edges = [e for e in edges if e.get('toNode') == asm['id'] and e.get('toPort') == 'meshes']
    if not mesh_edges:
        raise ValueError('No 3D part nodes connected to assembly_export')

    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1.0

    stage_root = out / 'staged_parts'
    if stage_root.exists():
        shutil.rmtree(stage_root)
    stage_root.mkdir(parents=True, exist_ok=True)

    def find_upstream_part_views(nid, seen=None):
        seen = seen or set()
        if not nid or nid in seen:
            return None
        seen.add(nid)
        nd = nodes.get(nid)
        if not nd:
            return None
        if nd.get('type') == 'part_views':
            return nd
        v_e = next((x for x in edges if x.get('toNode') == nid and x.get('toPort') == 'views'), None)
        if v_e and nodes.get(v_e['fromNode'], {}).get('type') == 'part_views':
            return nodes.get(v_e['fromNode'])
        m_e = next((x for x in edges if x.get('toNode') == nid and x.get('toPort') == 'mesh'), None)
        if m_e:
            return find_upstream_part_views(m_e['fromNode'], seen)
        return None

    bald_meshes = []
    hair_meshes = []

    for idx, edge in enumerate(mesh_edges):
        mn = nodes.get(edge['fromNode'])
        if not mn or mn.get('type') not in ('tripo_mesh', 'tripo_retexture'):
            continue
        cands = (mn.get('data') or {}).get('candidates') or []
        if not cands:
            continue
        sel_id = (mn.get('data') or {}).get('selectedId')
        cand = next((c for c in cands if c.get('id') == sel_id), cands[0])

        pv_node = find_upstream_part_views(mn['id'])
        part_label = ((pv_node or {}).get('params') or {}).get('partName') or (mn.get('params') or {}).get('title') or f'Part_{idx + 1}'
        clean_label = ''.join(ch if ch not in '\\/:*?"<>|' else '_' for ch in str(part_label)).strip() or f'Part_{idx + 1}'
        is_hair = bool(HAIR_NAME_RE.search(str(part_label)))

        part_stage = stage_root / f'p_{idx}_{mn["id"]}'
        part_stage.mkdir(parents=True, exist_ok=True)
        src_fbx = extracted / cand['path']
        fbx_stem = src_fbx.stem
        staged_fbx = part_stage / src_fbx.name
        shutil.copy2(src_fbx, staged_fbx)
        fbm_dir = part_stage / f'{fbx_stem}.fbm'
        fbm_dir.mkdir(parents=True, exist_ok=True)
        for res in cand.get('resources') or []:
            res_src = extracted / res['path']
            if res_src.is_file():
                shutil.copy2(res_src, part_stage / res_src.name)
                shutil.copy2(res_src, fbm_dir / res_src.name)

        before = set(bpy.data.objects)
        bpy.ops.import_scene.fbx(filepath=str(staged_fbx), use_image_search=True, use_anim=False)
        bpy.context.view_layer.update()
        added = set(bpy.data.objects) - before
        part_meshes = [o for o in added if o.type == 'MESH']
        if not part_meshes:
            continue

        t = (project.get('placements') or {}).get(mn['id'], {'position': [0.0, 0.0, 0.0], 'rotation': [0.0, 0.0, 0.0], 'scale': 1.0})
        mat = (
            Matrix.Translation(Vector(t['position']))
            @ Euler([radians(v) for v in t['rotation']], 'XYZ').to_matrix().to_4x4()
            @ Matrix.Scale(float(t['scale']), 4)
        )
        norm = cand.get('normalization')
        if norm and not norm.get('autoFit') and isinstance(norm.get('offset'), list):
            ox, oy, oz = norm['offset']
            mat = mat @ Matrix.Translation((ox, -oz, oy)) @ Matrix.Scale(float(norm['scale']), 4)
        else:
            xs0 = ys0 = zs0 = 1e18
            xs1 = ys1 = zs1 = -1e18
            for m_o in part_meshes:
                mw = m_o.matrix_world
                verts = m_o.data.vertices
                step = max(1, len(verts) // 200000)
                for vi in range(0, len(verts), step):
                    p_co = mw @ verts[vi].co
                    x, y, z = p_co.x, p_co.z, -p_co.y
                    xs0 = min(xs0, x); xs1 = max(xs1, x)
                    ys0 = min(ys0, y); ys1 = max(ys1, y)
                    zs0 = min(zs0, z); zs1 = max(zs1, z)
            sy = ys1 - ys0
            th = float((norm or {}).get('height') or 1.0)
            sc = (th / sy) if sy > 1e-6 else 1.0
            cx, cy, cz = (xs0 + xs1) * 0.5, (ys0 + ys1) * 0.5, (zs0 + zs1) * 0.5
            ox, oy, oz = -cx * sc, -cy * sc, -cz * sc
            mat = mat @ Matrix.Translation((ox, -oz, oy)) @ Matrix.Scale(sc, 4)

        roots = [o for o in added if o.parent not in added]
        grp = bpy.data.objects.new(f'grp_{mn["id"]}', None)
        bpy.context.scene.collection.objects.link(grp)
        grp.matrix_world = mat
        for r_obj in roots:
            orig_w = r_obj.matrix_world.copy()
            r_obj.parent = grp
            r_obj.matrix_parent_inverse = Matrix.Identity(4)
            r_obj.matrix_basis = orig_w
        bpy.context.view_layer.update()

        for sub_idx, m_obj in enumerate(part_meshes):
            for mod in list(m_obj.modifiers):
                if mod.type == 'ARMATURE':
                    m_obj.modifiers.remove(mod)
            m_obj.vertex_groups.clear()
            baked_world = m_obj.matrix_world.copy()
            m_obj.data = m_obj.data.copy()
            m_obj.data.transform(baked_world)
            m_obj.parent = None
            m_obj.matrix_world = Matrix.Identity(4)
            m_obj.name = clean_label if len(part_meshes) == 1 else f'{clean_label}_{sub_idx + 1}'
            if m_obj.name not in bpy.context.scene.collection.objects:
                bpy.context.scene.collection.objects.link(m_obj)
            if is_hair:
                decimate_if_needed(m_obj, 65000)
                hair_meshes.append(m_obj)
            else:
                decimate_if_needed(m_obj, 55000)
                bald_meshes.append(m_obj)

        for helper in list(added - set(part_meshes)) + [grp]:
            if helper.name in bpy.data.objects:
                bpy.data.objects.remove(helper, do_unlink=True)

    if not bald_meshes:
        raise ValueError('No body/head mesh found to rig (all connected parts were classified as hair)')

    if stage_only:
        # Export single-mesh lightweight bald GLB for Tripo cloud auto-rigging + separate hair blend
        export_mod.pack_all_images()
        bpy.ops.object.select_all(action='DESELECT')
        for bm in bald_meshes:
            bm.select_set(True)
        bpy.context.view_layer.objects.active = bald_meshes[0]
        if len(bald_meshes) > 1:
            bpy.ops.object.join()
        joined_bald = bpy.context.active_object
        joined_bald.name = 'MorphoGemBald'
        bald_glb = out / 'bald_for_rig.glb'
        bpy.ops.export_scene.gltf(
            filepath=str(bald_glb),
            export_format='GLB',
            use_selection=True,
            export_animations=False,
            export_image_format='JPEG',
            export_jpeg_quality=88,
            export_draco_mesh_compression_enable=False,
        )
        # Save hair-only blend preserving exact world transforms & materials
        bpy.ops.object.select_all(action='DESELECT')
        joined_bald.select_set(True)
        bpy.ops.object.delete(use_global=False)
        hair_blend = out / 'hair_only.blend'
        if hair_meshes:
            bpy.ops.wm.save_as_mainfile(filepath=str(hair_blend), copy=True)
        manifest = {
            'baldGlb': str(bald_glb),
            'hairBlend': str(hair_blend) if hair_meshes else '',
            'hairCount': len(hair_meshes),
            'materialMode': (asm.get('params') or {}).get('materialMode') or 'pbr',
        }
        (out / 'stage-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'[export-rigged-vrm] Staged bald GLB + {len(hair_meshes)} hair meshes for Tripo cloud VRM rig')
        return

    # Build VRM Humanoid Armature from bald body+head metrics & bind anatomical 4-bone weights
    metrics = rig_mod.measure_character(bald_meshes)
    arm_obj = rig_mod.build_vrm_armature(metrics)
    for bm in bald_meshes:
        rig_mod.assign_anatomical_vrm_weights(bm, arm_obj, metrics)

    # Bind independent hair meshes 100% to Head bone (zero shoulder weight bleed)
    for hm in hair_meshes:
        hm.vertex_groups.clear()
        vg = hm.vertex_groups.new(name='Head')
        vg.add(list(range(len(hm.data.vertices))), 1.0, 'REPLACE')
        hm.parent = arm_obj
        for mod in list(hm.modifiers):
            if mod.type == 'ARMATURE':
                hm.modifiers.remove(mod)
        amod = hm.modifiers.new(name='Armature', type='ARMATURE')
        amod.object = arm_obj

    all_meshes = bald_meshes + hair_meshes
    bpy.context.view_layer.update()
    export_mod.pack_all_images()

    bpy.ops.object.select_all(action='DESELECT')
    arm_obj.select_set(True)
    for m_obj in all_meshes:
        m_obj.hide_set(False)
        m_obj.hide_render = False
        m_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj

    fbx_out = out / 'rigged.fbx'
    glb_out = out / 'rigged.glb'
    blend_out = out / 'rigged.blend'

    bpy.ops.export_scene.fbx(
        filepath=str(fbx_out),
        use_selection=True,
        object_types={'ARMATURE', 'MESH'},
        bake_anim=False,
        add_leaf_bones=False,
        path_mode='COPY',
        embed_textures=True,
        axis_forward='-Z',
        axis_up='Y',
    )
    bpy.ops.export_scene.gltf(
        filepath=str(glb_out),
        export_format='GLB',
        use_selection=True,
        export_skins=True,
        export_animations=False,
        export_image_format='JPEG',
        export_jpeg_quality=92,
        export_draco_mesh_compression_enable=False,
    )

    if (asm.get('params') or {}).get('materialMode') == 'mtoon':
        try:
            export_mod.apply_anime_cel_shader(all_meshes)
        except Exception:
            pass
        export_mod.pack_all_images()

    bpy.ops.wm.save_as_mainfile(filepath=str(blend_out), copy=True)
    print(f'[export-rigged-vrm] Done: {len(bald_meshes)} rigged body/head + {len(hair_meshes)} Head-bound hair meshes')


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('destination')
    parser.add_argument('--assembly-node', default='')
    parser.add_argument('--stage-only', action='store_true')
    cfg = parser.parse_args(argv)
    run(cfg.source, cfg.destination, cfg.assembly_node, stage_only=cfg.stage_only)
