"""MorphoGem Clean-Room Blender Multi-Part Merger & Exporter (MIT License).

Merges arbitrary custom 3D parts wired into an Assembly node in `project.nodeGraph`
and exports full-precision static FBX, GLB, and Blend (with optional Anime Cel-Toon shader).

Command:
  blender --background --factory-startup --disable-autoexec --python-exit-code 1 \
    --python scripts/export-node-graph.py -- INPUT.mgem OUTPUT_DIR [--assembly-node ID]
"""
import argparse
import json
import shutil
import sys
import zipfile
from math import radians
from pathlib import Path
import bpy
from mathutils import Matrix, Vector, Euler


def pack_all_images():
    for img in bpy.data.images:
        if img.source == 'FILE' and not img.packed_file:
            resolved = Path(bpy.path.abspath(img.filepath, library=img.library))
            if resolved.is_file():
                img.pack()


def apply_anime_cel_shader(mesh_objects):
    """Converts standard imported materials on `mesh_objects` into clean 2-band Anime Cel-Toon
    node trees inside Blender while preserving base albedo textures."""
    visited_mats = set()
    for obj in mesh_objects:
        for slot in obj.material_slots:
            mat = slot.material
            if not mat or mat in visited_mats:
                continue
            visited_mats.add(mat)
            mat.use_nodes = True
            nt = mat.node_tree
            nodes = nt.nodes
            links = nt.links

            tex_node = next((n for n in nodes if n.type == 'TEX_IMAGE' and n.image), None)
            out_node = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL'), None)
            if not out_node:
                out_node = nodes.new('ShaderNodeOutputMaterial')

            diffuse = nodes.new('ShaderNodeBsdfDiffuse')
            diffuse.location = (-360, -120)

            s2rgb = nodes.new('ShaderNodeShaderToRGB')
            s2rgb.location = (-160, -120)
            links.new(diffuse.outputs['BSDF'], s2rgb.inputs['Shader'])

            ramp = nodes.new('ShaderNodeValToRGB')
            ramp.location = (40, -120)
            ramp.color_ramp.interpolation = 'CONSTANT'
            ramp.color_ramp.elements[0].position = 0.0
            ramp.color_ramp.elements[0].color = (0.78, 0.76, 0.86, 1.0)
            ramp.color_ramp.elements[1].position = 0.42
            ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1.0)
            links.new(s2rgb.outputs['Color'], ramp.inputs['Fac'])

            mix_col = nodes.new('ShaderNodeMix')
            mix_col.data_type = 'RGBA'
            mix_col.blend_type = 'MULTIPLY'
            mix_col.inputs['Factor'].default_value = 1.0
            mix_col.location = (320, 40)

            if tex_node:
                links.new(tex_node.outputs['Color'], mix_col.inputs[6])
            else:
                mix_col.inputs[6].default_value = (0.9, 0.9, 0.92, 1.0)
            links.new(ramp.outputs['Color'], mix_col.inputs[7])

            emission = nodes.new('ShaderNodeEmission')
            emission.location = (540, 40)
            emission.inputs['Strength'].default_value = 1.0
            links.new(mix_col.outputs[2], emission.inputs['Color'])
            links.new(emission.outputs['Emission'], out_node.inputs['Surface'])


def run(source_mgem, out_dir, assembly_node_id=''):
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

    all_exported_meshes = []
    stage_root = out / 'staged_parts'
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
                shutil.copy2(fbm_dir / res_src.name, fbm_dir / res_src.name) if (fbm_dir / res_src.name).exists() else shutil.copy2(res_src, fbm_dir / res_src.name)

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
            # Measure directly inside Blender if imported without prior Blender normalization
            pts = []
            for m_o in part_meshes:
                mw = m_o.matrix_world
                for v in m_o.data.vertices:
                    p_co = mw @ v.co
                    pts.append((p_co.x, p_co.z, -p_co.y))
            if pts:
                xs = [p[0] for p in pts]; ys = [p[1] for p in pts]; zs = [p[2] for p in pts]
                sy = max(ys) - min(ys)
                th = float((norm or {}).get('height') or 1.0)
                sc = (th / sy) if sy > 1e-6 else 1.0
                cx = (min(xs) + max(xs)) * 0.5
                cy = (min(ys) + max(ys)) * 0.5
                cz = (min(zs) + max(zs)) * 0.5
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
            all_exported_meshes.append(m_obj)

        for helper in list(added - set(part_meshes)) + [grp]:
            if helper.name in bpy.data.objects:
                bpy.data.objects.remove(helper, do_unlink=True)

    for obj in list(bpy.data.objects):
        if obj not in all_exported_meshes:
            bpy.data.objects.remove(obj, do_unlink=True)

    if not all_exported_meshes:
        raise ValueError('No valid mesh geometry found across connected nodes')

    bpy.context.view_layer.update()
    pack_all_images()

    bpy.ops.object.select_all(action='DESELECT')
    for m_obj in all_exported_meshes:
        m_obj.hide_set(False)
        m_obj.hide_render = False
        m_obj.select_set(True)
    bpy.context.view_layer.objects.active = all_exported_meshes[0]

    fbx_out = out / 'merged.fbx'
    glb_out = out / 'merged.glb'
    blend_out = out / 'merged.blend'

    bpy.ops.export_scene.fbx(
        filepath=str(fbx_out),
        use_selection=True,
        object_types={'MESH'},
        use_mesh_modifiers=False,
        use_triangles=False,
        bake_anim=False,
        add_leaf_bones=False,
        path_mode='COPY',
        embed_textures=True,
        axis_forward='-Z',
        axis_up='Y',
        bake_space_transform=True,
        apply_scale_options='FBX_SCALE_ALL',
    )
    bpy.ops.export_scene.gltf(
        filepath=str(glb_out),
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_animations=False,
        export_skins=False,
    )

    if (asm.get('params') or {}).get('materialMode') == 'mtoon':
        try:
            apply_anime_cel_shader(all_exported_meshes)
        except Exception:
            pass
        pack_all_images()

    bpy.ops.wm.save_as_mainfile(filepath=str(blend_out), copy=True)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('destination')
    parser.add_argument('--assembly-node', default='')
    cfg = parser.parse_args(argv)
    run(cfg.source, cfg.destination, cfg.assembly_node)
