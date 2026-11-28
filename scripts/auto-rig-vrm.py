"""MorphoGem Offline VRM-Standard Humanoid Auto-Rigger (Blender).

Generates a clean VRM 1.0 / Unity Humanoid compatible skeleton aligned to a
T-Pose bald character mesh (body + head, without hair), computes anatomically
isolated smooth skin weights (4-bone-per-vertex glTF/VRM compliant, never
failing on overlapping/non-manifold AI meshes), and exports a rigged FBX ready
for `attach-hair-to-rig.py` or VRM conversion.

Usage:
  blender --background --factory-startup --python-exit-code 1 \
    --python scripts/auto-rig-vrm.py -- \
    --input <bald_character.glb|fbx> \
    --output <rigged_bald.fbx>
"""
import argparse
import sys
from pathlib import Path
import numpy as np
import bpy
from mathutils import Vector


def import_mesh(filepath: Path):
    before = set(bpy.data.objects)
    ext = filepath.suffix.lower()
    if ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=str(filepath))
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=str(filepath), use_image_search=True, use_anim=False)
    else:
        raise ValueError(f'Unsupported format: {filepath}')
    bpy.context.view_layer.update()
    return [o for o in (set(bpy.data.objects) - before) if o.type == 'MESH']


def measure_character(meshes):
    pts = []
    for m in meshes:
        mw = m.matrix_world
        vco = np.empty(len(m.data.vertices) * 3, dtype=np.float32)
        m.data.vertices.foreach_get('co', vco)
        vco = vco.reshape((-1, 3))
        M = np.array(mw, dtype=np.float32)
        vw = vco @ M[:3, :3].T + M[:3, 3]
        pts.append(vw)
    all_pts = np.vstack(pts)
    z0, z1 = float(all_pts[:, 2].min()), float(all_pts[:, 2].max())
    h = z1 - z0
    x_min, x_max = float(all_pts[:, 0].min()), float(all_pts[:, 0].max())
    half_span = max(abs(x_min), abs(x_max))
    arm_pts = all_pts[np.abs(all_pts[:, 0]) > half_span * 0.45]
    arm_z = float(np.median(arm_pts[:, 2])) if len(arm_pts) else z0 + h * 0.76
    arm_y = float(np.median(arm_pts[:, 1])) if len(arm_pts) else 0.02
    shin_pts = all_pts[(all_pts[:, 2] > z0 + h * 0.15) & (all_pts[:, 2] < z0 + h * 0.35) & (all_pts[:, 0] > 0.01)]
    leg_x = float(np.median(shin_pts[:, 0])) if len(shin_pts) else h * 0.062
    leg_y = float(np.median(shin_pts[:, 1])) if len(shin_pts) else 0.01
    torso_pts = all_pts[(all_pts[:, 2] > z0 + h * 0.50) & (all_pts[:, 2] < z0 + h * 0.78) & (np.abs(all_pts[:, 0]) < leg_x * 1.5)]
    torso_y = float(np.median(torso_pts[:, 1])) if len(torso_pts) else 0.01
    return {
        'z0': z0, 'z1': z1, 'h': h,
        'half_span': half_span,
        'arm_z': arm_z, 'arm_y': arm_y,
        'leg_x': leg_x, 'leg_y': leg_y,
        'torso_y': torso_y,
    }


def build_vrm_armature(m):
    z0, h = m['z0'], m['h']
    ty, ly, ay = m['torso_y'], m['leg_y'], m['arm_y']
    lx, az, hs = m['leg_x'], m['arm_z'], m['half_span']

    arm_data = bpy.data.armatures.new('VRM_Armature')
    arm_obj = bpy.data.objects.new('VRM_Armature', arm_data)
    bpy.context.scene.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones

    def add_bone(name, head, tail, parent=None, connected=False):
        b = eb.new(name)
        b.head = Vector(head)
        b.tail = Vector(tail)
        if parent:
            b.parent = eb[parent]
            b.use_connect = connected
        return b

    hips_z = z0 + h * 0.50
    spine_z = z0 + h * 0.58
    chest_z = z0 + h * 0.67
    uchest_z = z0 + h * 0.76
    neck_z = z0 + h * 0.815
    head_z = z0 + h * 0.855
    head_top_z = z0 + h * 0.995

    add_bone('Hips',       (0, ty, hips_z),   (0, ty, spine_z))
    add_bone('Spine',      (0, ty, spine_z),  (0, ty, chest_z),  'Hips', True)
    add_bone('Chest',      (0, ty, chest_z),  (0, ty, uchest_z), 'Spine', True)
    add_bone('UpperChest', (0, ty, uchest_z), (0, ty, neck_z),   'Chest', True)
    add_bone('Neck',       (0, ty, neck_z),   (0, ty, head_z),   'UpperChest', True)
    add_bone('Head',       (0, ty, head_z),   (0, ty, head_top_z), 'Neck', True)

    shld_x = lx * 1.10
    uarm_x = lx * 1.75
    larm_x = hs * 0.53
    hand_x = hs * 0.80
    tip_x  = hs * 0.96

    for side, sgn in (('Left', 1.0), ('Right', -1.0)):
        add_bone(f'{side}Shoulder', (sgn * shld_x * 0.45, ay, az), (sgn * uarm_x, ay, az), 'UpperChest', False)
        add_bone(f'{side}UpperArm', (sgn * uarm_x, ay, az), (sgn * larm_x, ay, az), f'{side}Shoulder', True)
        add_bone(f'{side}LowerArm', (sgn * larm_x, ay, az), (sgn * hand_x, ay, az), f'{side}UpperArm', True)
        add_bone(f'{side}Hand',     (sgn * hand_x, ay, az), (sgn * tip_x,  ay, az), f'{side}LowerArm', True)

    uleg_z = z0 + h * 0.475
    knee_z = z0 + h * 0.265
    foot_z = z0 + h * 0.055
    toe_z  = z0 + h * 0.015

    for side, sgn in (('Left', 1.0), ('Right', -1.0)):
        add_bone(f'{side}UpperLeg', (sgn * lx, ly, uleg_z), (sgn * lx, ly - 0.008, knee_z), 'Hips', False)
        add_bone(f'{side}LowerLeg', (sgn * lx, ly - 0.008, knee_z), (sgn * lx, ly + 0.006, foot_z), f'{side}UpperLeg', True)
        add_bone(f'{side}Foot',     (sgn * lx, ly + 0.006, foot_z), (sgn * lx, ly - 0.065, toe_z), f'{side}LowerLeg', True)
        add_bone(f'{side}Toes',     (sgn * lx, ly - 0.065, toe_z),  (sgn * lx, ly - 0.105, toe_z), f'{side}Foot', True)

    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.update()
    return arm_obj


def point_to_segment_dist(pts, a, b):
    ab = b - a
    ab_len2 = float(np.dot(ab, ab))
    if ab_len2 < 1e-10:
        return np.linalg.norm(pts - a, axis=1)
    t = np.clip(((pts - a) @ ab) / ab_len2, 0.0, 1.0)
    proj = a + t[:, None] * ab[None, :]
    return np.linalg.norm(pts - proj, axis=1)


def assign_anatomical_vrm_weights(mesh_obj, arm_obj, m):
    """Anatomically isolated smooth segment-distance skinning (100% reliable on AI meshes)."""
    z0, h, lx = m['z0'], m['h'], m['leg_x']
    uarm_x = lx * 1.75
    neck_z = z0 + h * 0.815
    hips_z = z0 + h * 0.50

    me = mesh_obj.data
    n_verts = len(me.vertices)
    vco = np.empty(n_verts * 3, dtype=np.float32)
    me.vertices.foreach_get('co', vco)
    pts = vco.reshape((-1, 3))

    bones = list(arm_obj.data.bones)
    bone_names = [b.name for b in bones]
    n_bones = len(bones)

    # Precompute distances from every vertex to every bone segment
    dists = np.full((n_verts, n_bones), 1e6, dtype=np.float32)
    for bi, b in enumerate(bones):
        a = np.array(b.head_local, dtype=np.float32)
        c = np.array(b.tail_local, dtype=np.float32)
        dists[:, bi] = point_to_segment_dist(pts, a, c)

    # Anatomical region masks to prevent cross-limb bleeding (left/right legs, arms/torso, head/shoulders)
    is_left_leg = (pts[:, 2] < hips_z) & (pts[:, 0] >= 0.0)
    is_right_leg = (pts[:, 2] < hips_z) & (pts[:, 0] < 0.0)
    is_left_arm = (pts[:, 2] > hips_z + h * 0.14) & (pts[:, 0] > uarm_x * 0.85)
    is_right_arm = (pts[:, 2] > hips_z + h * 0.14) & (pts[:, 0] < -uarm_x * 0.85)
    is_head_zone = (pts[:, 2] > neck_z + h * 0.015)

    for bi, bname in enumerate(bone_names):
        if (bname.startswith('Left') and 'Leg' in bname) or bname in ('LeftFoot', 'LeftToes'):
            dists[~is_left_leg, bi] = 1e6
        elif (bname.startswith('Right') and 'Leg' in bname) or bname in ('RightFoot', 'RightToes'):
            dists[~is_right_leg, bi] = 1e6
        elif bname in ('LeftUpperArm', 'LeftLowerArm', 'LeftHand'):
            dists[~is_left_arm, bi] = 1e6
        elif bname in ('RightUpperArm', 'RightLowerArm', 'RightHand'):
            dists[~is_right_arm, bi] = 1e6
        elif bname in ('LeftShoulder', 'RightShoulder'):
            dists[is_head_zone, bi] = 1e6
            if bname == 'LeftShoulder':
                dists[pts[:, 0] < 0.0, bi] = 1e6
            else:
                dists[pts[:, 0] > 0.0, bi] = 1e6
        elif bname == 'Head':
            dists[pts[:, 2] < neck_z, bi] = 1e6
        elif bname in ('Hips', 'Spine', 'Chest', 'UpperChest'):
            dists[is_left_arm | is_right_arm | is_head_zone, bi] = 1e6
            if bname != 'Hips':
                dists[pts[:, 2] < hips_z - h * 0.03, bi] = 1e6

    # Smooth inverse-distance falloff weights (sigma = 0.045m for crisp yet organic joint bending)
    sigma = 0.048
    w_mat = np.exp(- (dists / sigma) ** 2)
    # Keep top-4 bones per vertex (VRM / glTF 2.0 standard)
    top4_idx = np.argpartition(-w_mat, 4, axis=1)[:, :4]
    rows = np.arange(n_verts)[:, None]
    top4_w = w_mat[rows, top4_idx]
    w_sum = top4_w.sum(axis=1, keepdims=True)
    # Fallback to nearest bone if all top4 weights underflowed
    zero_mask = (w_sum[:, 0] < 1e-8)
    if zero_mask.any():
        nearest = np.argmin(dists[zero_mask], axis=1)
        top4_idx[zero_mask, 0] = nearest
        top4_w[zero_mask, :] = 0.0
        top4_w[zero_mask, 0] = 1.0
        w_sum = top4_w.sum(axis=1, keepdims=True)
    top4_w /= w_sum

    mesh_obj.vertex_groups.clear()
    vgs = [mesh_obj.vertex_groups.new(name=bn) for bn in bone_names]
    for vi in range(n_verts):
        for k in range(4):
            wt = float(top4_w[vi, k])
            if wt > 1e-4:
                vgs[int(top4_idx[vi, k])].add([vi], wt, 'REPLACE')

    # Parent to armature with Armature modifier
    mesh_obj.parent = arm_obj
    for mod in list(mesh_obj.modifiers):
        if mod.type == 'ARMATURE':
            mesh_obj.modifiers.remove(mod)
    amod = mesh_obj.modifiers.new(name='Armature', type='ARMATURE')
    amod.object = arm_obj
    print(f'[auto-rig-vrm] Assigned clean 4-bone anatomical VRM weights to {n_verts} vertices!')


def run(input_path: Path, output_fbx: Path):
    output_fbx.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

    meshes = import_mesh(input_path)
    if not meshes:
        raise RuntimeError(f'No meshes in {input_path}')

    bpy.ops.object.select_all(action='DESELECT')
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    metrics = measure_character(meshes)
    print('[auto-rig-vrm] Character metrics:', metrics)
    arm_obj = build_vrm_armature(metrics)

    for m in meshes:
        assign_anatomical_vrm_weights(m, arm_obj, metrics)
    bpy.context.view_layer.update()

    for img in bpy.data.images:
        if img.source == 'FILE' and not img.packed_file:
            p = Path(bpy.path.abspath(img.filepath, library=img.library))
            if p.is_file():
                img.pack()

    bpy.ops.object.select_all(action='DESELECT')
    arm_obj.select_set(True)
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.export_scene.fbx(
        filepath=str(output_fbx),
        use_selection=True,
        object_types={'ARMATURE', 'MESH'},
        bake_anim=False,
        add_leaf_bones=False,
        path_mode='COPY',
        embed_textures=True,
        axis_forward='-Z',
        axis_up='Y',
    )
    print('[auto-rig-vrm] Exported VRM-rigged bald FBX:', output_fbx)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    args = ap.parse_args(argv)
    run(Path(args.input), Path(args.output))


if __name__ == '__main__':
    main()
