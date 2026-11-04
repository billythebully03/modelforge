import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const MODEL_RE = /\.(glb|gltf|fbx|obj|dae)$/i;
const ATT_COLOR = 0xff9f0a;
const SNAP_PX = 44;

/* ================= Scene ================= */

const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(2, 1.2, 3);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const transform = new TransformControls(camera, renderer.domElement);
transform.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  if (!e.value && transform.mode === 'translate') snapToBone();
});
scene.add(transform);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8e8e98, 1.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 5, 4);
scene.add(sun);

const grid = new THREE.GridHelper(40, 80, 0x8e8e98, 0xb0b0b8);
grid.material.transparent = true;
grid.material.opacity = 0.35;
scene.add(grid);

const modelRoot = new THREE.Group();
scene.add(modelRoot);

/* ================= State ================= */

const state = {
  name: '',
  model: null,
  mixer: null,
  clips: [],          // clips that came with the file
  clipKey: null,      // null | 'custom' | index into clips
  customClip: null,
  clipName: 'idle',
  keys: [],           // [{ t, pose: { boneName: [x, y, z, w] } }]
  action: null,
  playing: false,
  loop: true,
  time: 0,
  duration: 1,
  bones: [],
  skeleton: null,
  showBones: true,
  attachments: [],    // THREE.Group, editor-only
  selectedAtt: null,
  selectedBone: null,
  unit: 0.1,          // visual size of attachment markers
};

/* ================= Loading ================= */

async function loadFiles(list) {
  const files = [...list];
  const main = files.find((f) => MODEL_RE.test(f.name));
  if (!main) return toast('Нужен файл модели: .glb, .gltf, .fbx, .obj или .dae');

  // Textures / .bin / .mtl that were selected together with the model
  // are served from blob URLs, matched by file name.
  const urls = new Map(files.map((f) => [f.name, URL.createObjectURL(f)]));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const base = decodeURIComponent(url.split(/[\\/]/).pop().split('?')[0]);
    return urls.get(base) || url;
  });

  $('loading').hidden = false;
  try {
    const ext = main.name.split('.').pop().toLowerCase();
    const mainUrl = urls.get(main.name);
    let object;
    let anims = [];

    if (ext === 'glb' || ext === 'gltf') {
      const gltf = await new GLTFLoader(manager).loadAsync(mainUrl);
      object = gltf.scene;
      anims = gltf.animations;
    } else if (ext === 'fbx') {
      object = await new FBXLoader(manager).loadAsync(mainUrl);
      anims = object.animations || [];
    } else if (ext === 'obj') {
      const loader = new OBJLoader(manager);
      const mtl = files.find((f) => /\.mtl$/i.test(f.name));
      if (mtl) {
        const mats = await new MTLLoader(manager).loadAsync(urls.get(mtl.name));
        mats.preload();
        loader.setMaterials(mats);
      }
      object = await loader.loadAsync(mainUrl);
    } else {
      const collada = await new ColladaLoader(manager).loadAsync(mainUrl);
      object = collada.scene;
      anims = collada.animations || [];
    }

    setModel(object, anims, main.name);
  } catch (err) {
    console.error(err);
    toast('Не удалось открыть модель');
  } finally {
    $('loading').hidden = true;
  }
}

function setModel(obj, anims, name) {
  clearModel();
  state.name = name;
  state.model = obj;
  modelRoot.add(obj);

  obj.traverse((o) => {
    if (o.isBone) {
      o.userData.rest = { q: o.quaternion.clone() };
      o.userData.euler = [0, 0, 0];
      state.bones.push(o);
    }
  });

  state.clips = anims;
  state.mixer = new THREE.AnimationMixer(obj);

  state.skeleton = new THREE.SkeletonHelper(obj);
  state.skeleton.visible = state.showBones;
  scene.add(state.skeleton);

  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  state.unit = (Math.max(size.x, size.y, size.z) * 0.05) || 0.1;
  grid.position.y = box.isEmpty() ? 0 : box.min.y;
  frameBox(box);

  $('dropHint').hidden = true;
  $('btnBones').classList.toggle('on', state.showBones);
  activateClip(false);
  renderAll();
}

function clearModel() {
  // Keep attachments in the scene: they must not die with the old model.
  for (const att of [...state.attachments]) scene.attach(att);

  if (state.mixer) state.mixer.stopAllAction();
  modelRoot.clear();
  if (state.skeleton) scene.remove(state.skeleton);

  Object.assign(state, {
    model: null, mixer: null, clips: [], clipKey: null, customClip: null,
    keys: [], action: null, playing: false, time: 0, duration: 1,
    bones: [], skeleton: null, selectedBone: null,
  });
}

function frameBox(box) {
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 0.05);
  const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15;

  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(1, 0.5, 1.2).normalize().multiplyScalar(dist));
  camera.near = dist / 500;
  camera.far = dist * 200;
  camera.updateProjectionMatrix();
  controls.minDistance = radius * 0.1;
  controls.maxDistance = dist * 10;
  controls.update();
}

function zoom(factor) {
  const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor);
  camera.position.copy(controls.target).add(offset);
  controls.update();
}

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

/* ================= Bones & pose ================= */

function boneKey(bone) {
  const parts = [];
  for (let o = bone; o && o !== state.model; o = o.parent) parts.unshift(o.name || '?');
  return parts.join('/');
}

function applyBoneEuler(bone) {
  const [x, y, z] = bone.userData.euler.map(THREE.MathUtils.degToRad);
  const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
  bone.quaternion.copy(bone.userData.rest.q).multiply(delta);
}

function resetPose() {
  for (const b of state.bones) {
    b.userData.euler = [0, 0, 0];
    b.quaternion.copy(b.userData.rest.q);
  }
  renderInspector();
}

/* ================= Animation ================= */

function currentClip() {
  if (state.clipKey === 'custom') return state.customClip;
  if (typeof state.clipKey === 'number') return state.clips[state.clipKey] || null;
  return null;
}

function rebuildCustomClip() {
  if (state.mixer && state.customClip) state.mixer.uncacheClip(state.customClip);
  state.customClip = null;
  if (!state.keys.length || !state.bones.length) return;

  const keys = [...state.keys].sort((a, b) => a.t - b.t);
  const tracks = [];
  for (const bone of state.bones) {
    const times = [];
    const values = [];
    for (const k of keys) {
      const q = k.pose[bone.name];
      if (!q) continue;
      times.push(k.t);
      values.push(...q);
    }
    if (times.length) {
      const track = `${THREE.PropertyBinding.sanitizeNodeName(bone.name)}.quaternion`;
      tracks.push(new THREE.QuaternionKeyframeTrack(track, times, values));
    }
  }
  const duration = Math.max(keys[keys.length - 1].t, 0.001);
  state.customClip = new THREE.AnimationClip(state.clipName || 'idle', duration, tracks);
}

function activateClip(keepTime) {
  if (state.action) state.action.stop();
  state.action = null;
  state.playing = false;

  const clip = currentClip();
  if (clip && state.mixer) {
    const action = state.mixer.clipAction(clip);
    action.setLoop(state.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !state.loop;
    action.paused = true;
    action.play();
    state.action = action;
    state.duration = clip.duration;
    state.time = keepTime ? Math.min(state.time, clip.duration) : 0;
    action.time = state.time;
    state.mixer.update(0);
  } else {
    state.duration = 1;
    state.time = 0;
  }

  updatePlayButton();
  updateTimeUI();
  updateClipSelect();
}

function updateClipSelect() {
  const opts = ['<option value="none">— без клипа —</option>'];
  if (state.keys.length) opts.push('<option value="custom">Свой клип (ключи)</option>');
  state.clips.forEach((c, i) => {
    opts.push(`<option value="${i}">${esc(c.name || `Клип ${i + 1}`)}</option>`);
  });
  const sel = $('clipSelect');
  sel.innerHTML = opts.join('');
  sel.value = state.clipKey === null ? 'none' : String(state.clipKey);
}

function togglePlay() {
  if (!state.action) {
    if (!currentClip()) return toast('Сначала запиши ключи или выбери клип');
    activateClip(true);
  }
  if (!state.playing && !state.loop && state.time >= state.duration - 1e-3) setTime(0);

  state.playing = !state.playing;
  state.action.paused = !state.playing;
  if (state.playing) state.action.play();
  updatePlayButton();
}

function updatePlayButton() {
  $('btnPlay').textContent = state.playing ? '❚❚' : '▶';
}

function setTime(t) {
  state.time = Math.max(0, Math.min(t, state.duration));
  if (!state.action && currentClip()) activateClip(true);
  if (state.action) {
    state.action.time = state.time;
    state.mixer.update(0);
  }
  updateTimeUI();
}

function updateTimeUI() {
  const scrub = $('scrub');
  scrub.max = state.duration;
  scrub.value = state.time;
  $('timeLabel').textContent = `${state.time.toFixed(2)} / ${state.duration.toFixed(2)} s`;
}

function recordKey() {
  if (!state.bones.length) return toast('В модели нет костей');
  const t = Math.round(state.time * 1000) / 1000;
  const pose = {};
  for (const b of state.bones) pose[b.name] = b.quaternion.toArray();

  const idx = state.keys.findIndex((k) => Math.abs(k.t - t) < 5e-4);
  if (idx >= 0) state.keys[idx].pose = pose;
  else state.keys.push({ t, pose });

  state.clipKey = 'custom';
  rebuildCustomClip();
  activateClip(true);
  toast(`Ключ на ${t.toFixed(2)} с`);
}

function deleteKey() {
  const i = state.keys.findIndex((k) => Math.abs(k.t - state.time) < 5e-4);
  if (i < 0) return toast('На этом времени ключа нет');
  state.keys.splice(i, 1);
  rebuildCustomClip();
  if (!state.keys.length && state.clipKey === 'custom') state.clipKey = null;
  activateClip(true);
}

function clearClip() {
  if (!state.keys.length) return;
  if (!confirm('Удалить все ключи этого клипа?')) return;
  state.keys = [];
  rebuildCustomClip();
  state.clipKey = null;
  activateClip(false);
}

/* ================= Attachments ================= */

function makeAttachmentMesh(name) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: ATT_COLOR, depthTest: false, transparent: true });
  const cube = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), mat);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 16), mat);
  arrow.rotation.x = Math.PI / 2;   // points along +Z (the attachment's forward)
  arrow.position.z = 0.6;
  cube.renderOrder = 999;
  arrow.renderOrder = 999;
  group.add(cube, arrow);
  group.name = name;
  group.scale.setScalar(state.unit);
  return group;
}

function addAttachment() {
  let n = state.attachments.length + 1;
  while (state.attachments.some((a) => a.name === `attach_${n}`)) n++;
  const att = makeAttachmentMesh(`attach_${n}`);
  att.position.copy(controls.target);
  scene.add(att);
  state.attachments.push(att);
  selectAtt(att);
}

function removeAttachment(att) {
  att.removeFromParent();
  state.attachments = state.attachments.filter((a) => a !== att);
  if (state.selectedAtt === att) deselect();
  else renderAll();
}

function bindAttachment(att, bone) {
  // attach() keeps the attachment where it is on screen
  if (bone) bone.attach(att);
  else scene.attach(att);
  renderAll();
}

function toScreen(v, w, h) {
  const ndc = v.clone().project(camera);
  if (ndc.z > 1) return null;
  return { x: ((ndc.x + 1) / 2) * w, y: ((1 - ndc.y) / 2) * h };
}

// After dragging an attachment with the move gizmo, bind it to the nearest bone on screen
function snapToBone() {
  const att = state.selectedAtt;
  if (!att || !state.bones.length) return;
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  const from = toScreen(att.getWorldPosition(new THREE.Vector3()), w, h);
  if (!from) return;

  let best = null;
  let bestDist = SNAP_PX;
  const p = new THREE.Vector3();
  for (const bone of state.bones) {
    const s = toScreen(bone.getWorldPosition(p), w, h);
    if (!s) continue;
    const d = Math.hypot(s.x - from.x, s.y - from.y);
    if (d < bestDist) {
      bestDist = d;
      best = bone;
    }
  }
  if (best && best !== att.parent) {
    bindAttachment(att, best);
    toast(`Блок привязан к «${best.name || 'кости'}»`);
  }
}

function selectAtt(att) {
  state.selectedAtt = att;
  state.selectedBone = null;
  transform.attach(att);
  renderAll();
}

function selectBone(bone) {
  state.selectedBone = bone;
  state.selectedAtt = null;
  transform.detach();
  renderAll();
}

function deselect() {
  state.selectedAtt = null;
  state.selectedBone = null;
  transform.detach();
  renderAll();
}

function setGizmoMode(mode) {
  transform.setMode(mode);
  renderInspector();
}

/* ---- Picking in the viewport (tap = select, drag = orbit) ---- */

let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 6) return;
  pickAt(e);
});

function pickAt(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(state.attachments, true);
  for (const hit of hits) {
    let o = hit.object;
    while (o && !state.attachments.includes(o)) o = o.parent;
    if (o) return selectAtt(o);
  }
  deselect();
}

/* ================= Export ================= */

function baseName() {
  return (state.name || 'model').replace(/\.[^.]+$/, '');
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportAttachments() {
  if (!state.attachments.length) return toast('Блоков пока нет');
  const data = {
    format: 'modelforge.attachments',
    version: 1,
    model: state.name,
    attachments: state.attachments.map((a) => ({
      name: a.name,
      bone: a.parent && a.parent.isBone ? boneKey(a.parent) : null,
      position: a.position.toArray(),
      quaternion: a.quaternion.toArray(),
      scale: a.scale.toArray(),
    })),
  };
  download(`${baseName()}.attachments.json`, JSON.stringify(data, null, 2));
}

function exportAnimation() {
  const clip = currentClip();
  if (!clip) return toast('Нет клипа: запиши ключи или выбери готовый');
  const json = THREE.AnimationClip.toJSON(clip);
  download(`${baseName()}.${clip.name || 'clip'}.animation.json`, JSON.stringify(json));
}

/* ================= Inspector / outliner ================= */

function renderAll() {
  renderOutliner();
  renderAttList();
  renderInspector();
}

function renderOutliner() {
  const el = $('outliner');
  el.innerHTML = '';
  if (!state.model) {
    el.innerHTML = '<p class="muted">Модель не загружена</p>';
    return;
  }
  if (!state.bones.length) {
    el.innerHTML = '<p class="muted">В модели нет костей</p>';
    return;
  }
  const walk = (obj, depth) => {
    for (const child of obj.children) {
      if (child.isBone) {
        const row = document.createElement('div');
        row.className = 'row-item' + (child === state.selectedBone ? ' sel' : '');
        row.style.paddingLeft = `${8 + depth * 12}px`;
        const label = document.createElement('span');
        label.textContent = child.name || '(без имени)';
        row.appendChild(label);
        row.onclick = () => selectBone(child);
        el.appendChild(row);
        walk(child, depth + 1);
      } else {
        walk(child, depth);
      }
    }
  };
  walk(state.model, 0);
}

function renderAttList() {
  const el = $('attList');
  el.innerHTML = '';
  if (!state.attachments.length) {
    el.innerHTML = '<p class="muted">Блоков нет. Нажми «+ Блок».</p>';
    return;
  }
  for (const att of state.attachments) {
    const row = document.createElement('div');
    row.className = 'row-item' + (att === state.selectedAtt ? ' sel' : '');
    const name = document.createElement('span');
    name.textContent = att.name;
    const where = document.createElement('small');
    where.textContent = att.parent && att.parent.isBone ? att.parent.name : 'сцена';
    row.append(name, where);
    row.onclick = () => selectAtt(att);
    el.appendChild(row);
  }
}

function renderInspector() {
  const el = $('inspector');
  el.innerHTML = '';
  if (state.selectedAtt) return renderAttInspector(el, state.selectedAtt);
  if (state.selectedBone) return renderBoneInspector(el, state.selectedBone);
  el.innerHTML = '<p class="muted">Выбери кость или блок.<br><br>Блоки видны только в редакторе. Их можно привязать к кости перетаскиванием.</p>';
}

function renderBoneInspector(el, bone) {
  const euler = bone.userData.euler;
  el.innerHTML = `<div class="title">${esc(bone.name || 'Кость')}</div>`
    + ['X', 'Y', 'Z'].map((ax, i) => `
      <label class="slider">
        <span>${ax}</span>
        <input type="range" min="-180" max="180" step="1" value="${euler[i]}" data-axis="${i}">
        <output>${Math.round(euler[i])}°</output>
      </label>`).join('')
    + `<div class="row"><button id="boneReset">Сбросить позу</button></div>
       <p class="muted">Поворот относительно покоя. Чтобы сохранить позу в клип, нажми «● Ключ» на таймлайне.</p>`;

  el.querySelectorAll('input[type="range"]').forEach((inp) => {
    inp.oninput = () => {
      bone.userData.euler[Number(inp.dataset.axis)] = Number(inp.value);
      inp.nextElementSibling.textContent = `${inp.value}°`;
      applyBoneEuler(bone);
    };
  });
  $('boneReset').onclick = resetPose;
}

function renderAttInspector(el, att) {
  const opts = ['<option value="">— сцена —</option>'];
  state.bones.forEach((b, i) => {
    opts.push(`<option value="${i}"${att.parent === b ? ' selected' : ''}>${esc(boneKey(b))}</option>`);
  });

  el.innerHTML = `
    <div class="title">Блок</div>
    <label class="field">Имя
      <input id="attName" type="text" value="${esc(att.name)}" spellcheck="false" autocomplete="off">
    </label>
    <label class="field">Кость
      <select id="attBone">${opts.join('')}</select>
    </label>
    <div class="seg">
      <button data-mode="translate" class="${transform.mode === 'translate' ? 'on' : ''}">Перемещение</button>
      <button data-mode="rotate" class="${transform.mode === 'rotate' ? 'on' : ''}">Поворот</button>
    </div>
    <p class="muted">Перетащи блок к кости в режиме перемещения, и он привяжется. В экспорт попадают имя, кость и положение относительно неё.</p>
    <div class="row" style="margin-top:12px">
      <button id="attDetach">Отвязать</button>
      <button id="attDelete" class="danger">Удалить</button>
    </div>`;

  $('attName').onchange = (e) => {
    const clean = e.target.value.trim().replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
    if (!clean || state.attachments.some((a) => a !== att && a.name === clean)) {
      toast('Имя пустое или уже занято');
      e.target.value = att.name;
      return;
    }
    att.name = clean;
    renderAll();
  };
  $('attBone').onchange = (e) => {
    bindAttachment(att, e.target.value === '' ? null : state.bones[Number(e.target.value)]);
  };
  el.querySelectorAll('.seg button').forEach((btn) => {
    btn.onclick = () => setGizmoMode(btn.dataset.mode);
  });
  $('attDetach').onclick = () => bindAttachment(att, null);
  $('attDelete').onclick = () => removeAttachment(att);
}

/* ================= Toast ================= */

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ================= Input wiring ================= */

$('btnOpen').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  loadFiles(e.target.files);
  e.target.value = '';
};

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

$('btnFrame').onclick = () => {
  if (state.model) frameBox(new THREE.Box3().setFromObject(state.model));
};
$('zIn').onclick = () => zoom(0.8);
$('zOut').onclick = () => zoom(1.25);

$('btnBones').onclick = () => {
  state.showBones = !state.showBones;
  if (state.skeleton) state.skeleton.visible = state.showBones;
  $('btnBones').classList.toggle('on', state.showBones);
};

$('btnAddAtt').onclick = addAttachment;
$('btnExportAtt').onclick = exportAttachments;
$('btnExportAnim').onclick = exportAnimation;

$('btnPlay').onclick = togglePlay;
$('btnRecord').onclick = recordKey;
$('btnDelKey').onclick = deleteKey;
$('btnClearClip').onclick = clearClip;

$('scrub').oninput = (e) => {
  if (state.playing) togglePlay();
  setTime(Number(e.target.value));
};

$('clipSelect').onchange = (e) => {
  const v = e.target.value;
  state.clipKey = v === 'none' ? null : v === 'custom' ? 'custom' : Number(v);
  activateClip(false);
};

$('clipName').onchange = (e) => {
  state.clipName = e.target.value.trim().replace(/\s+/g, '_') || 'idle';
  e.target.value = state.clipName;
  if (state.customClip) state.customClip.name = state.clipName;
};

$('loopToggle').onchange = (e) => {
  state.loop = e.target.checked;
  if (state.action) {
    state.action.setLoop(state.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    state.action.clampWhenFinished = !state.loop;
  }
};

function togglePanel(side) {
  const panel = document.querySelector(`.panel.${side}`);
  const other = document.querySelector(`.panel.${side === 'left' ? 'right' : 'left'}`);
  other.classList.remove('open');
  panel.classList.toggle('open');
}
$('btnLeft').onclick = () => togglePanel('left');
$('btnRight').onclick = () => togglePanel('right');
viewport.addEventListener('pointerdown', () => {
  document.querySelectorAll('.panel.open').forEach((p) => p.classList.remove('open'));
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedAtt) {
    removeAttachment(state.selectedAtt);
  } else if (e.key === '1' && state.selectedAtt) {
    setGizmoMode('translate');
  } else if (e.key === '2' && state.selectedAtt) {
    setGizmoMode('rotate');
  } else if (e.key === 'Escape') {
    deselect();
  }
});

/* ================= Render loop ================= */

const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();

  if (state.playing && state.action) {
    state.mixer.update(dt);
    state.time = state.action.time;
    if (!state.loop && state.time >= state.duration) {
      state.time = state.duration;
      state.playing = false;
      state.action.paused = true;
      state.action.time = state.duration;
      state.mixer.update(0);
      updatePlayButton();
    }
    updateTimeUI();
  }

  controls.update();
  renderer.render(scene, camera);
}

resize();
updateTimeUI();
updateClipSelect();
renderAll();
tick();
