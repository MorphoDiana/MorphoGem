// MorphoGem Clean-Room Three.js 3D Multi-Part Assembly & Proportion Viewport (100% Original MIT)
import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {GLTFLoader} from './vendor/GLTFLoader.js';
import {FBXLoader} from './vendor/FBXLoader.js';
import {
  ensureNodeGraph,
  connectedAssemblyMeshes,
  connectedAssemblyGuide,
  defaultPlacementForPartName,
  defaultHeightForPartName,
} from './node-graph.mjs';
import {tr} from './i18n.mjs';

// Basis conversion between Blender Z-up (x, y, z) and Three.js Y-up (x, z, -y)
// v_three = B_TO_T * v_blender
const B_TO_T = new THREE.Matrix4().set(
  1, 0,  0, 0,
  0, 0,  1, 0,
  0, -1, 0, 0,
  0, 0,  0, 1
);
const T_TO_B = B_TO_T.clone().invert();

export function initViewport3D(hooks) {
  const stageWrap = document.querySelector('#vpCanvasWrap');
  const emptyOverlay = document.querySelector('#vpEmptyOverlay');
  const heightBadge = document.querySelector('#vpTotalHeightBadge');
  const partsListEl = document.querySelector('#vpPartsList');
  const partCountBadge = document.querySelector('#vpPartCountBadge');
  const selectedPartTitle = document.querySelector('#vpSelectedPartTitle');
  const targetHeightInput = document.querySelector('#vpTargetHeightInput');
  const matModeSelect = document.querySelector('#vpMaterialModeSelect');

  const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  stageWrap.prepend(renderer.domElement);

  const scene = new THREE.Scene();

  // Balanced neutral studio lighting for clear silhouette & albedo inspection
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x334155, 1.35);
  hemiLight.position.set(0, 4, 0);
  scene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
  keyLight.position.set(2.2, 3.6, 3.4);
  scene.add(keyLight);

  const backFill = new THREE.DirectionalLight(0x93c5fd, 0.55);
  backFill.position.set(-2.2, 2.2, -3.0);
  scene.add(backFill);

  // Metric floor grid (2.4m × 2.4m, 10cm subdivisions)
  const grid = new THREE.GridHelper(2.4, 24, 0x38bdf8, 0x1e293b);
  grid.position.y = 0;
  scene.add(grid);

  // Perspective + Orthographic Cameras
  const perspCam = new THREE.PerspectiveCamera(36, 1, 0.02, 60);
  perspCam.position.set(0, 1.05, 3.2);

  const orthoCam = new THREE.OrthographicCamera(-1.2, 1.2, 1.2, -1.2, 0.01, 60);
  orthoCam.position.set(0, 0.9, 5);

  let activeCam = perspCam;
  let activeCamMode = 'orbit';

  const controls = new OrbitControls(perspCam, renderer.domElement);
  controls.target.set(0, 0.85, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const assemblyRoot = new THREE.Group();
  scene.add(assemblyRoot);

  // Reference Balance Guide Planes (Front & Right Side)
  const guideGroup = new THREE.Group();
  scene.add(guideGroup);
  let showGuides = true;
  let showWireframe = false;

  // Selection bounding box helper
  const selectionBox = new THREE.BoxHelper(new THREE.Mesh(), 0x60a5fa);
  selectionBox.visible = false;
  scene.add(selectionBox);

  const gltfLoader = new GLTFLoader();
  const fbxLoader = new FBXLoader();

  // Cache loaded normalized models by candidate sha256 so slider drags are 60fps instant
  const modelCache = new Map(); // sha256 -> THREE.Object3D (normalized at origin)
  const partGroups = new Map(); // meshNodeId -> { outerGroup, label, hidden }
  let selectedMeshNodeId = null;
  let guideUrls = [];

  function resizeViewport() {
    const rect = stageWrap.getBoundingClientRect();
    const w = Math.max(120, rect.width);
    const h = Math.max(120, rect.height);
    renderer.setSize(w, h, false);
    const aspect = w / h;
    perspCam.aspect = aspect;
    perspCam.updateProjectionMatrix();

    const halfH = 1.15;
    orthoCam.left = -halfH * aspect;
    orthoCam.right = halfH * aspect;
    orthoCam.top = halfH;
    orthoCam.bottom = -halfH;
    orthoCam.updateProjectionMatrix();
  }

  const ro = new ResizeObserver(() => resizeViewport());
  ro.observe(stageWrap);

  function computeBlenderPlacementMatrixThree(placement) {
    const [px, py, pz] = placement?.position || [0, 0, 0];
    const [rx, ry, rz] = placement?.rotation || [0, 0, 0];
    const sc = Number.isFinite(placement?.scale) ? placement.scale : 1;

    // Exact match to Blender: Translation(px, py, pz) @ Euler(rx, ry, rz, 'XYZ') @ Scale(sc)
    const mTrans = new THREE.Matrix4().makeTranslation(px, py, pz);
    const mRot = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(rx),
        THREE.MathUtils.degToRad(ry),
        THREE.MathUtils.degToRad(rz),
        'XYZ'
      )
    );
    const mScale = new THREE.Matrix4().makeScale(sc, sc, sc);
    const mBlender = mTrans.multiply(mRot).multiply(mScale);
    return B_TO_T.clone().multiply(mBlender).multiply(T_TO_B);
  }

  function applyWireframeState(rootObj) {
    rootObj.traverse(obj => {
      if (!obj.isMesh || !obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        m.wireframe = showWireframe;
      }
    });
  }

  async function loadCandidateObject3D(cand, partLabel, filesMap) {
    if (modelCache.has(cand.sha256)) {
      return modelCache.get(cand.sha256).clone(true);
    }

    let rawObj = null;

    // 1. Try fast GLB proxy if server generated one
    try {
      const res = await fetch(`/api/preview-glb/${cand.sha256}.glb`);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const gltf = await gltfLoader.parseAsync(buf, '');
        rawObj = gltf.scene;
      }
    } catch {
      // fallback to direct FBX load
    }

    // 2. Direct Three.js FBXLoader from in-memory .mgem `filesMap` (works even without Blender!)
    if (!rawObj) {
      const fbxBytes = filesMap.get(cand.path);
      if (!fbxBytes) throw Error(`Missing FBX bytes for ${cand.path}`);
      const texBlobUrls = new Map();
      for (const r of cand.resources || []) {
        const rBytes = filesMap.get(r.path);
        if (rBytes) {
          const ext = r.path.split('.').pop()?.toLowerCase();
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
          const url = URL.createObjectURL(new Blob([rBytes], {type: mime}));
          texBlobUrls.set(r.path.split('/').pop().toLowerCase(), url);
        }
      }
      const manager = new THREE.LoadingManager();
      manager.setURLModifier(url => {
        const base = decodeURIComponent(url).replace(/\\/g, '/').split('/').pop().toLowerCase();
        return texBlobUrls.get(base) || url;
      });
      const loader = new FBXLoader(manager);
      const ab = fbxBytes.buffer.slice(fbxBytes.byteOffset, fbxBytes.byteOffset + fbxBytes.byteLength);
      rawObj = loader.parse(ab, '');
      setTimeout(() => {
        for (const u of texBlobUrls.values()) URL.revokeObjectURL(u);
      }, 8000);
    }

    // Normalize into centered part space matching `cand.normalization`
    const normWrapper = new THREE.Group();
    const norm = cand.normalization;
    if (norm && !norm.autoFit && Array.isArray(norm.offset)) {
      rawObj.scale.setScalar(Number(norm.scale) || 1);
      rawObj.position.set(norm.offset[0] || 0, norm.offset[1] || 0, norm.offset[2] || 0);
    } else {
      const box = new THREE.Box3().setFromObject(rawObj);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const targetH = norm?.height || defaultHeightForPartName(partLabel);
      const sc = size.y > 1e-5 ? targetH / size.y : 1;
      rawObj.scale.setScalar(sc);
      rawObj.position.set(-center.x * sc, -center.y * sc, -center.z * sc);
      cand.normalization = {
        scale: sc,
        offset: [-center.x * sc, -center.y * sc, -center.z * sc],
        height: targetH,
      };
    }
    normWrapper.add(rawObj);
    modelCache.set(cand.sha256, normWrapper);
    return normWrapper.clone(true);
  }

  function updateTotalHeightMetric() {
    if (!partGroups.size) {
      heightBadge.textContent = tr('当前总高: -- m', 'Total Height: -- m');
      return null;
    }
    const box = new THREE.Box3();
    let hasVisible = false;
    for (const item of partGroups.values()) {
      if (!item.hidden) {
        box.expandByObject(item.outerGroup);
        hasVisible = true;
      }
    }
    if (!hasVisible || box.isEmpty()) {
      heightBadge.textContent = tr('当前总高: -- m', 'Total Height: -- m');
      return null;
    }
    const h = Math.max(0, box.max.y - box.min.y);
    heightBadge.textContent = tr(
      `当前总高: ${h.toFixed(3)} m (底 ${box.min.y.toFixed(2)}m)`,
      `Total Height: ${h.toFixed(3)} m (Base ${box.min.y.toFixed(2)}m)`
    );
    return box;
  }

  function refreshSelectionOutline() {
    const entry = selectedMeshNodeId ? partGroups.get(selectedMeshNodeId) : null;
    if (entry && !entry.hidden) {
      selectionBox.setFromObject(entry.outerGroup);
      selectionBox.visible = true;
    } else {
      selectionBox.visible = false;
    }
  }

  function syncTransformInputsFromSelected() {
    const {project} = hooks.get();
    const hasSel = selectedMeshNodeId && partGroups.has(selectedMeshNodeId);
    const card = document.querySelector('#vpTransformCard');
    card.style.opacity = hasSel ? '1' : '0.5';
    card.style.pointerEvents = hasSel ? 'auto' : 'none';
    if (!hasSel) {
      selectedPartTitle.textContent = tr('✥ 选中部件空间微调', '✥ Part Transform');
      return;
    }
    const info = partGroups.get(selectedMeshNodeId);
    selectedPartTitle.textContent = `✥ ${info.label}`;
    const pl = project.placements?.[selectedMeshNodeId] || {
      position: defaultPlacementForPartName(info.label),
      rotation: [0, 0, 0],
      scale: 1,
    };
    const setPair = (idBase, val) => {
      const r = document.getElementById(`${idBase}Range`);
      const n = document.getElementById(`${idBase}Num`);
      if (r) r.value = String(val);
      if (n) n.value = String(Number(val.toFixed(3)));
    };
    setPair('tfScale', pl.scale ?? 1);
    setPair('tfPosX', pl.position?.[0] ?? 0);
    setPair('tfPosY', pl.position?.[1] ?? 0);
    setPair('tfPosZ', pl.position?.[2] ?? 0.85);
    setPair('tfRotX', pl.rotation?.[0] ?? 0);
    setPair('tfRotY', pl.rotation?.[1] ?? 0);
    setPair('tfRotZ', pl.rotation?.[2] ?? 0);
  }

  function applyPlacementToScenePart(meshNodeId) {
    const {project} = hooks.get();
    const entry = partGroups.get(meshNodeId);
    if (!entry) return;
    const pl = project.placements?.[meshNodeId] || {
      position: defaultPlacementForPartName(entry.label),
      rotation: [0, 0, 0],
      scale: 1,
    };
    const mat = computeBlenderPlacementMatrixThree(pl);
    entry.outerGroup.matrixAutoUpdate = false;
    entry.outerGroup.matrix.copy(mat);
    entry.outerGroup.updateMatrixWorld(true);
    updateTotalHeightMetric();
    refreshSelectionOutline();
  }

  function rebuildGuidePlanes(project, files) {
    while (guideGroup.children.length) guideGroup.remove(guideGroup.children[0]);
    for (const u of guideUrls) URL.revokeObjectURL(u);
    guideUrls = [];

    const views = connectedAssemblyGuide(project.nodeGraph);
    if (!views) return;
    const h = Number(project.targetHeight) || 1.60;
    const loader = new THREE.TextureLoader();

    const addPlane = (doc, pos, rotY) => {
      const bytes = doc?.path ? files.get(doc.path) : null;
      if (!bytes) return;
      const url = URL.createObjectURL(new Blob([bytes], {type: doc.mime || 'image/png'}));
      guideUrls.push(url);
      const tex = loader.load(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      const geo = new THREE.PlaneGeometry(h, h);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(pos[0], h * 0.5, pos[2]);
      mesh.rotation.y = rotY;
      guideGroup.add(mesh);
    };

    addPlane(views.front, [0, 0, -0.75], 0);
    addPlane(views.side, [-0.75, 0, 0], Math.PI / 2);
    guideGroup.visible = showGuides;
  }

  let syncToken = 0;
  async function syncSceneFromProject() {
    const myToken = ++syncToken;
    const {project, files} = hooks.get();
    const g = ensureNodeGraph(project);
    const connected = connectedAssemblyMeshes(g);

    targetHeightInput.value = String((Number(project.targetHeight) || 1.60).toFixed(2));
    const asmNode = g.nodes.find(n => n.type === 'assembly_export');
    if (asmNode?.params?.materialMode) {
      matModeSelect.value = asmNode.params.materialMode;
    }

    partCountBadge.textContent = String(connected.length);
    emptyOverlay.hidden = connected.length > 0;

    // Keep visibility flags across syncs
    const prevHidden = new Map();
    for (const [k, v] of partGroups.entries()) prevHidden.set(k, v.hidden);

    while (assemblyRoot.children.length) assemblyRoot.remove(assemblyRoot.children[0]);
    partGroups.clear();

    for (const item of connected) {
      try {
        const obj = await loadCandidateObject3D(item.candidate, item.partLabel, files);
        if (myToken !== syncToken) return;
        applyWireframeState(obj);

        project.placements ??= {};
        project.placements[item.meshNodeId] ??= {
          position: defaultPlacementForPartName(item.partLabel, item.index),
          rotation: [0, 0, 0],
          scale: 1,
        };

        const outerGroup = new THREE.Group();
        outerGroup.add(obj);
        const hidden = Boolean(prevHidden.get(item.meshNodeId));
        outerGroup.visible = !hidden;
        assemblyRoot.add(outerGroup);

        partGroups.set(item.meshNodeId, {
          outerGroup,
          label: item.partLabel,
          hidden,
          candidate: item.candidate,
        });
        applyPlacementToScenePart(item.meshNodeId);
      } catch (err) {
        console.warn('Viewport mesh load skipped:', err);
      }
    }

    if (!selectedMeshNodeId || !partGroups.has(selectedMeshNodeId)) {
      selectedMeshNodeId = connected[0]?.meshNodeId || null;
    }

    rebuildGuidePlanes(project, files);
    renderPartsListUI();
    syncTransformInputsFromSelected();
    updateTotalHeightMetric();
    refreshSelectionOutline();
  }

  function renderPartsListUI() {
    partsListEl.innerHTML = '';
    if (!partGroups.size) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#64748b;font-size:12px;padding:6px 2px';
      empty.textContent = tr('暂无接入部件', 'No connected 3D parts');
      partsListEl.append(empty);
      return;
    }
    for (const [meshNodeId, info] of partGroups.entries()) {
      const row = document.createElement('div');
      row.className = `vp-part-item${selectedMeshNodeId === meshNodeId ? ' selected' : ''}`;
      const nameSpan = document.createElement('span');
      nameSpan.className = 'vp-part-name';
      nameSpan.textContent = info.label;

      const eyeBtn = document.createElement('button');
      eyeBtn.type = 'button';
      eyeBtn.className = 'vp-part-eye';
      eyeBtn.textContent = info.hidden ? '🚫' : '👁';
      eyeBtn.title = tr('显示/隐藏该部件', 'Toggle part visibility');
      eyeBtn.onclick = ev => {
        ev.stopPropagation();
        info.hidden = !info.hidden;
        info.outerGroup.visible = !info.hidden;
        eyeBtn.textContent = info.hidden ? '🚫' : '👁';
        updateTotalHeightMetric();
        refreshSelectionOutline();
      };

      row.onclick = () => {
        selectedMeshNodeId = meshNodeId;
        renderPartsListUI();
        syncTransformInputsFromSelected();
        refreshSelectionOutline();
      };

      row.append(nameSpan, eyeBtn);
      partsListEl.append(row);
    }
  }

  // --- Transform Sliders & Numeric Inputs Binding ---
  function bindTransformControl(idBase, applyFn) {
    const rangeEl = document.getElementById(`${idBase}Range`);
    const numEl = document.getElementById(`${idBase}Num`);
    const handle = valStr => {
      if (!selectedMeshNodeId || !partGroups.has(selectedMeshNodeId)) return;
      const v = Number.parseFloat(valStr);
      if (!Number.isFinite(v)) return;
      const {project} = hooks.get();
      const info = partGroups.get(selectedMeshNodeId);
      project.placements ??= {};
      project.placements[selectedMeshNodeId] ??= {
        position: defaultPlacementForPartName(info.label),
        rotation: [0, 0, 0],
        scale: 1,
      };
      applyFn(project.placements[selectedMeshNodeId], v);
      if (rangeEl) rangeEl.value = String(v);
      if (numEl) numEl.value = String(v);
      applyPlacementToScenePart(selectedMeshNodeId);
      hooks.changed();
    };
    if (rangeEl) rangeEl.addEventListener('input', e => handle(e.target.value));
    if (numEl) numEl.addEventListener('change', e => handle(e.target.value));
  }

  bindTransformControl('tfScale', (pl, v) => { pl.scale = Math.max(0.02, v); });
  bindTransformControl('tfPosX', (pl, v) => { pl.position[0] = v; });
  bindTransformControl('tfPosY', (pl, v) => { pl.position[1] = v; });
  bindTransformControl('tfPosZ', (pl, v) => { pl.position[2] = v; });
  bindTransformControl('tfRotX', (pl, v) => { pl.rotation[0] = v; });
  bindTransformControl('tfRotY', (pl, v) => { pl.rotation[1] = v; });
  bindTransformControl('tfRotZ', (pl, v) => { pl.rotation[2] = v; });

  document.querySelector('#vpResetPartBtn').onclick = () => {
    if (!selectedMeshNodeId || !partGroups.has(selectedMeshNodeId)) return;
    const {project} = hooks.get();
    const info = partGroups.get(selectedMeshNodeId);
    project.placements ??= {};
    project.placements[selectedMeshNodeId] = {
      position: defaultPlacementForPartName(info.label),
      rotation: [0, 0, 0],
      scale: 1,
    };
    applyPlacementToScenePart(selectedMeshNodeId);
    syncTransformInputsFromSelected();
    hooks.changed();
  };

  // --- Uniform Total Height Calibration & Ground Snap ---
  document.querySelector('#vpApplyHeightBtn').onclick = () => {
    const desiredH = Number.parseFloat(targetHeightInput.value);
    if (!Number.isFinite(desiredH) || desiredH < 0.1 || desiredH > 15) return;
    const box = updateTotalHeightMetric();
    if (!box || box.isEmpty()) return;
    const curH = box.max.y - box.min.y;
    if (curH < 1e-4) return;

    const ratio = desiredH / curH;
    const baseMinY = box.min.y;
    const {project} = hooks.get();
    project.targetHeight = desiredH;

    for (const [meshNodeId, info] of partGroups.entries()) {
      const pl = project.placements?.[meshNodeId] || {
        position: defaultPlacementForPartName(info.label),
        rotation: [0, 0, 0],
        scale: 1,
      };
      pl.scale = Number((pl.scale * ratio).toFixed(4));
      pl.position[0] = Number((pl.position[0] * ratio).toFixed(4));
      pl.position[1] = Number((pl.position[1] * ratio).toFixed(4));
      pl.position[2] = Number(((pl.position[2] - baseMinY) * ratio).toFixed(4));
      project.placements[meshNodeId] = pl;
      applyPlacementToScenePart(meshNodeId);
    }
    syncTransformInputsFromSelected();
    hooks.changed();
    hooks.toast(tr(`✓ 已按总高 ${desiredH.toFixed(2)}m 等比校准并贴齐地面`, `✓ Calibrated assembly to ${desiredH.toFixed(2)}m & grounded`));
  };

  matModeSelect.onchange = () => {
    const {project} = hooks.get();
    const asm = ensureNodeGraph(project).nodes.find(n => n.type === 'assembly_export');
    if (asm) {
      asm.params.materialMode = matModeSelect.value;
      hooks.changed();
    }
  };

  document.querySelector('#vpExportMergedBtn').onclick = () => {
    const {project} = hooks.get();
    const asm = ensureNodeGraph(project).nodes.find(n => n.type === 'assembly_export');
    hooks.exportGraphAssets(asm?.id || '');
  };

  document.querySelector('#vpBackToCanvasBtn').onclick = () => {
    window.dispatchEvent(new CustomEvent('morphogem-switch-workspace', {detail: 'canvas'}));
  };

  // --- Camera Presets & Viewport Toolbar ---
  function setCameraPreset(mode) {
    activeCamMode = mode;
    for (const btn of stageWrap.querySelectorAll('.vp-cam-btn[data-cam]')) {
      btn.classList.toggle('active', btn.dataset.cam === mode);
    }
    const box = updateTotalHeightMetric();
    const centerY = box && !box.isEmpty() ? (box.min.y + box.max.y) * 0.5 : 0.85;
    const span = box && !box.isEmpty() ? Math.max(0.6, (box.max.y - box.min.y) * 0.7) : 1.1;

    if (mode === 'orbit') {
      activeCam = perspCam;
      controls.object = perspCam;
      controls.enableRotate = true;
      perspCam.position.set(0.6, centerY + 0.25, span * 2.8);
      controls.target.set(0, centerY, 0);
      controls.update();
      return;
    }

    activeCam = orthoCam;
    controls.object = orthoCam;
    controls.enableRotate = false;
    const aspect = perspCam.aspect || 1.4;
    orthoCam.top = span;
    orthoCam.bottom = -span;
    orthoCam.left = -span * aspect;
    orthoCam.right = span * aspect;
    orthoCam.zoom = 1;
    orthoCam.updateProjectionMatrix();

    const dist = 8;
    if (mode === 'front') orthoCam.position.set(0, centerY, dist);
    else if (mode === 'back') orthoCam.position.set(0, centerY, -dist);
    else if (mode === 'right') orthoCam.position.set(dist, centerY, 0);
    else if (mode === 'left') orthoCam.position.set(-dist, centerY, 0);
    else if (mode === 'top') orthoCam.position.set(0, centerY + dist, 0.001);
    controls.target.set(0, centerY, 0);
    controls.update();
  }

  stageWrap.querySelectorAll('.vp-cam-btn[data-cam]').forEach(btn => {
    btn.onclick = () => setCameraPreset(btn.dataset.cam);
  });

  document.querySelector('#vpFitBtn').onclick = () => setCameraPreset(activeCamMode);
  document.querySelector('#vpGuideToggleBtn').onclick = ev => {
    showGuides = !showGuides;
    guideGroup.visible = showGuides;
    ev.currentTarget.classList.toggle('active', showGuides);
  };
  document.querySelector('#vpWireframeBtn').onclick = ev => {
    showWireframe = !showWireframe;
    ev.currentTarget.classList.toggle('active', showWireframe);
    for (const info of partGroups.values()) {
      applyWireframeState(info.outerGroup);
    }
  };

  // Click-to-pick part directly in 3D canvas
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  renderer.domElement.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, activeCam);
    const roots = [];
    const ownerMap = new Map();
    for (const [id, info] of partGroups.entries()) {
      if (!info.hidden) {
        roots.push(info.outerGroup);
        info.outerGroup.traverse(o => ownerMap.set(o, id));
      }
    }
    const hits = raycaster.intersectObjects(roots, true);
    if (hits.length) {
      const pickedId = ownerMap.get(hits[0].object);
      if (pickedId && pickedId !== selectedMeshNodeId) {
        selectedMeshNodeId = pickedId;
        renderPartsListUI();
        syncTransformInputsFromSelected();
        refreshSelectionOutline();
      }
    }
  });

  // Render loop (only renders when viewport is visible to save GPU while on Node Canvas)
  function animate() {
    requestAnimationFrame(animate);
    if (document.body.classList.contains('node-graph-active')) return;
    controls.update();
    renderer.render(scene, activeCam);
  }
  resizeViewport();
  animate();

  return {
    sync: syncSceneFromProject,
    resize: resizeViewport,
    refreshLabels: () => {
      renderPartsListUI();
      syncTransformInputsFromSelected();
      updateTotalHeightMetric();
    },
  };
}
