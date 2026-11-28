"""MorphoGem Blender Rigged Character Hair Attacher & VRM-Ready Exporter.

Re-attaches a separate sculpted hair mesh (from a MorphoGem hair node) onto the
`Head` bone of a VRM/Mixamo/Humanoid rigged bald body FBX, with 100% head-bone
weight so shoulder/arm movements never pull or stretch hair strands.

Usage:
  blender --background --factory-startup --python-exit-code 1 \
    --python scripts/attach-hair-to-rig.py -- \
    --rigged-bald <rigged_bald.fbx> \
    --hair <hair.fbx|hair.glb|hair.blend> \
    --out-dir <output_dir> \
    [--hair-pos 0,0,0] [--hair-scale 1.0] [--test-pose]
"""
import argparse
import math
import sys
from pathlib import Path
import bpy
from mathutils import Vector, Euler


HEAD_BONE_CANDIDATES = (
    'head',
    'j_bip_c_head',
    'mixamorig:head',
    'bip01_head',
    'def-head',
    'valvebiped.bip01_head1',
)


def find_head_bone(armature_obj):
    bones = armature_obj.data.bones
    for cand in HEAD_BONE_CANDIDATES:
        for b in bones:
            if b.name.lower() == cand:
                return b
    for b in bones:
        if 'head' in b.name.lower() and 'top' not in b.name.lower() and 'end' not in b.name.lower():
            return b
    return None


def import_any(filepath: Path):
    before = set(bpy.data.objects)
    ext = filepath.suffix.lower()
    if ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=str(filepath), use_image_search=True, use_anim=False)
    elif ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=str(filepath))
    elif ext == '.blend':
        with bpy.data.libraries.load(str(filepath), link=False) as (data_from, data_to):
            data_to.objects = [name for name in data_from.objects]
        for obj in data_to.objects:
            if obj is not None:
                bpy.context.scene.collection.objects.link(obj)
    else:
        raise ValueError(f'Unsupported 3D format: {filepath}')
    bpy.context.view_layer.update()
    return list(set(bpy.data.objects) - before)


def attach_hair_to_head(rigged_bald_path: Path, hair_path: Path, out_dir: Path, hair_pos=(0.0, 0.0, 0.0), hair_scale=1.0, test_pose=False):
    out_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

    bald_objs = import_any(rigged_bald_path)
    armatures = [o for o in bald_objs if o.type == 'ARMATURE']
    if not armatures:
        raise RuntimeError(f'No Armature found in {rigged_bald_path}')
    arm = armatures[0]
    head_bone = find_head_bone(arm)
    if not head_bone:
        raise RuntimeError(f'No Head bone found in armature "{arm.name}". Bones: {[b.name for b in arm.data.bones]}')
    print(f'[attach-hair] Found armature="{arm.name}", head_bone="{head_bone.name}"')

    if hair_path and str(hair_path).strip():
        hair_objs = import_any(hair_path)
        hair_meshes = [o for o in hair_objs if o.type == 'MESH']
        if not hair_meshes:
            raise RuntimeError(f'No mesh found in hair asset: {hair_path}')

        # Optional placement offset/scale for hair
        for hm in hair_meshes:
            if hair_scale != 1.0:
                hm.scale = Vector(hm.scale) * float(hair_scale)
            if any(abs(v) > 1e-6 for v in hair_pos):
                hm.location = Vector(hm.location) + Vector(hair_pos)
        bpy.context.view_layer.update()

        # Bind each hair mesh 100% cleanly to the Head bone via Armature modifier + vertex group
        # (Preserves world transform and prevents any shoulder/upper-arm weight bleed!)
        for hm in hair_meshes:
            hm.vertex_groups.clear()
            vg = hm.vertex_groups.new(name=head_bone.name)
            all_idx = list(range(len(hm.data.vertices)))
            vg.add(all_idx, 1.0, 'REPLACE')

            # Parent to armature keeping world transform
            saved_world = hm.matrix_world.copy()
            hm.parent = arm
            hm.matrix_parent_inverse = arm.matrix_world.inverted()
            hm.matrix_world = saved_world

            for mod in list(hm.modifiers):
                if mod.type == 'ARMATURE':
                    hm.modifiers.remove(mod)
            arm_mod = hm.modifiers.new(name='Armature', type='ARMATURE')
            arm_mod.object = arm
            print(f'[attach-hair] Bound "{hm.name}" ({len(all_idx)} verts) 100% -> "{head_bone.name}"')

    bpy.context.view_layer.update()

    # Pack all images so exported .blend/.fbx/.glb are self-contained
    for img in bpy.data.images:
        if img.source == 'FILE' and not img.packed_file:
            resolved = Path(bpy.path.abspath(img.filepath, library=img.library))
            if resolved.is_file():
                img.pack()

    # Export complete rigged FBX, GLB, and Blend
    export_objs = [arm] + [o for o in bpy.data.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in export_objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm

    fbx_out = out_dir / 'rigged_with_hair.fbx'
    glb_out = out_dir / 'rigged_with_hair.glb'
    blend_out = out_dir / 'rigged_with_hair.blend'

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
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_out), copy=True)
    print(f'[attach-hair] Exported: {fbx_out.name}, {glb_out.name}, {blend_out.name}')

    if test_pose:
        # Tilt head slightly and raise left arm to verify zero hair-to-shoulder stretching
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.mode_set(mode='POSE')
        pb_head = arm.pose.bones.get(head_bone.name)
        if pb_head:
            pb_head.rotation_mode = 'XYZ'
            pb_head.rotation_euler = Euler((math.radians(8), math.radians(10), math.radians(-14)), 'XYZ')
        for bname in arm.pose.bones.keys():
            low = bname.lower()
            if ('upperarm' in low or 'upper_arm' in low or 'arm' in low) and ('l' in low.split('_') or low.endswith('.l') or 'left' in low):
                pb = arm.pose.bones[bname]
                pb.rotation_mode = 'XYZ'
                pb.rotation_euler = Euler((0, 0, math.radians(-35)), 'XYZ')
                break
        bpy.ops.object.mode_set(mode='OBJECT')
        bpy.context.view_layer.update()

        scene = bpy.context.scene
        scene.render.engine = 'BLENDER_EEVEE'
        scene.eevee.taa_render_samples = 16
        scene.render.resolution_x = 900
        scene.render.resolution_y = 900
        if not scene.world:
            scene.world = bpy.data.worlds.new('World')
        bg = scene.world.node_tree.nodes.get('Background')
        if bg:
            bg.inputs[0].default_value = (0.14, 0.17, 0.23, 1.0)
            bg.inputs[1].default_value = 1.15
        ld = bpy.data.lights.new('Key', type='AREA'); ld.energy = 180; ld.size = 3.0
        lo = bpy.data.objects.new('Key', ld); bpy.context.scene.collection.objects.link(lo)
        lo.location = Vector((1.2, -2.5, 2.0))
        lo.rotation_euler = (Vector((0, 0, 1.1)) - lo.location).to_track_quat('-Z', 'Y').to_euler()
        cd = bpy.data.cameras.new('C'); cam = bpy.data.objects.new('C', cd)
        bpy.context.scene.collection.objects.link(cam); scene.camera = cam
        cd.type = 'ORTHO'; cd.ortho_scale = 1.95
        cam.location = Vector((0, -3.5, 0.88))
        cam.rotation_euler = (Vector((0, 0, 0.88)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(out_dir / 'pose_test_verify.png')
        bpy.ops.render.render(write_still=True)
        print('[attach-hair] Saved pose test render:', out_dir / 'pose_test_verify.png')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--rigged-bald', required=True)
    ap.add_argument('--hair', default='')
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--hair-pos', default='0,0,0')
    ap.add_argument('--hair-scale', type=float, default=1.0)
    ap.add_argument('--test-pose', action='store_true')
    args = ap.parse_args(argv)
    pos = tuple(float(v) for v in args.hair_pos.split(','))
    hair_p = Path(args.hair) if args.hair else None
    attach_hair_to_head(Path(args.rigged_bald), hair_p, Path(args.out_dir), pos, args.hair_scale, args.test_pose)


if __name__ == '__main__':
    main()
