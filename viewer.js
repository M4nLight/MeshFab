/* ============================================================
   ModelStage — просмотрщик модели на three.js (глобальный THREE).
   Подключается классическими <script>, чтобы сайт работал
   даже при открытии index.html двойным кликом (file://).
   Умеет то, чего нет у model-viewer:
   - кости (SkeletonHelper) и влияние кости на вершины (Bones Influence)
   - wireframe (сетка полигонов)
   - vertex normals (нормали вертексов в цветах)
   - просмотр текстур слотов (Base Color, Normal, Roughness…) без света
   - отключение пост-обработки (tone mapping)
============================================================ */

// Слоты текстур GLTF, которые мы умеем показывать
const TEX_SLOTS = [
    ['map',           'Base Color'],
    ['normalMap',     'Normal Map'],
    ['roughnessMap',  'Roughness Map'],
    ['metalnessMap',  'Metallic Map'],
    ['aoMap',         'Ambient Occlusion'],
    ['emissiveMap',   'Emissive'],
];

class ModelStage {
    constructor(container) {
        this.container = container;

        // --- Рендерер ---
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.outputEncoding = THREE.sRGBEncoding;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping; // «пост-обработка» по умолчанию
        container.appendChild(this.renderer.domElement);

        // --- Сцена, камера, свет ---
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
        this.camera.position.set(2.5, 1.6, 3.5);

        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.1));
        const dir = new THREE.DirectionalLight(0xffffff, 1.0);
        dir.position.set(4, 6, 3);
        this.scene.add(dir);

        // --- Управление камерой (вращение/зум как в Sketchfab) ---
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.autoRotateSpeed = 2.0;

        // Корневая группа, куда загружается модель
        this.root = new THREE.Group();
        this.scene.add(this.root);

        // Маркер выбранной кости (маленькая сфера)
        this.boneMarker = new THREE.Mesh(
            new THREE.SphereGeometry(0.025, 12, 12),
            new THREE.MeshBasicMaterial({ color: 0x1caad9 })
        );
        this.boneMarker.visible = false;
        this.scene.add(this.boneMarker);

        // Состояние
        this.model = null;          // загруженная gltf.scene
        this.origMaterials = new Map(); // mesh -> исходный материал
        this.bones = [];            // плоский список костей {bone, depth}
        this.selectedBone = null;
        this.influenceMeshes = [];  // меши с подсветкой влияния кости

        // Режимы
        this.modes = { noPost: false, autorotate: false, wireframe: false, normals: false, bones: false };

        this.onTextures = null; // колбэк: передаём список текстур в UI
        this.onBones = null;    // колбэк: передаём список костей в UI

        // Размеры под контейнер
        new ResizeObserver(() => this.resize()).observe(container);
        this.resize();

        // Цикл отрисовки
        const loop = () => {
            this.controls.update();
            if (this.selectedBone) {
                this.selectedBone.getWorldPosition(this.boneMarker.position);
            }
            this.renderer.render(this.scene, this.camera);
            requestAnimationFrame(loop);
        };
        loop();
    }

    resize() {
        const w = this.container.clientWidth || 1;
        const h = this.container.clientHeight || 1;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    // ---------- Загрузка модели ----------
    load(src, defaults = {}) {
        // Чистим предыдущую модель
        if (this.model) {
            this.clearInfluence();
            this.root.remove(this.model);
            this.model = null;
        }
        this.bones = [];
        this.selectedBone = null;
        this.boneMarker.visible = false;
        this.origMaterials.clear();
        if (this.bonesHelper) { this.scene.remove(this.bonesHelper); this.bonesHelper = null; }

        const loader = new THREE.GLTFLoader();
        loader.load(src, (gltf) => {
            this.model = gltf.scene;
            this.root.add(this.model);

            // Считаем кости из всех SkinnedMesh
            this.collectBones();

            // Автомасштаб: модель помещается в кадр
            const box = new THREE.Box3().setFromObject(this.model);
            const size = box.getSize(new THREE.Vector3()).length();
            const center = box.getCenter(new THREE.Vector3());
            this.model.position.sub(center);
            if (size > 0) this.model.scale.multiplyScalar(2.5 / size);

            // Сброс камеры
            this.camera.position.set(2.5, 1.6, 3.5);
            this.controls.target.set(0, 0, 0);
            this.controls.update();

            // Собираем список текстур и отдаём в UI
            const texList = this.collectTextures();
            if (this.onTextures) this.onTextures(texList);

            // Начальные режимы: настройки из Sttng + выбор при выкладывании
            this.setMode('noPost', !!defaults.noPost);
            this.setMode('autorotate', !!defaults.autorotate);
            this.setMode('wireframe', !!defaults.wireframe);
            this.setMode('normals', !!defaults.normals);
            this.setMode('bones', !!defaults.showBones);
        });
    }

    // ---------- Кости ----------
    collectBones() {
        const seen = new Set();
        this.model.traverse(o => {
            if (o.isSkinnedMesh && o.skeleton && !seen.has(o.skeleton)) {
                seen.add(o.skeleton);
                o.skeleton.bones.forEach(b => {
                    if (!this.bones.some(x => x.bone === b)) {
                        this.bones.push({ bone: b, depth: this.boneDepth(b) });
                    }
                });
            }
        });
        if (this.onBones) this.onBones(this.bones);
    }

    boneDepth(bone) {
        let d = 0, p = bone.parent;
        while (p && p.isBone) { d++; p = p.parent; }
        return d;
    }

    setBonesVisible(v) {
        if (v && !this.bonesHelper && this.bones.length) {
            this.bonesHelper = new THREE.SkeletonHelper(this.model);
            this.scene.add(this.bonesHelper);
        }
        if (!v && this.bonesHelper) {
            this.scene.remove(this.bonesHelper);
            this.bonesHelper = null;
        }
    }

    // Выбор кости: маркер + подсветка влияния на вершины
    selectBone(bone) {
        this.selectedBone = bone;
        this.clearInfluence();
        if (!bone) { this.boneMarker.visible = false; return; }
        this.boneMarker.visible = true;
        if (this.modes.bones) this.showInfluence(bone);
    }

    // Bones Influence: красим вершины по весу выбранной кости
    showInfluence(bone) {
        this.model.traverse(o => {
            if (!o.isSkinnedMesh || !o.skeleton) return;
            const idx = o.skeleton.bones.indexOf(bone);
            if (idx < 0) return;

            const geo = o.geometry;
            const si = geo.attributes.skinIndex;
            const sw = geo.attributes.skinWeight;
            if (!si || !sw) return;

            const count = si.count;
            const colors = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                // суммарный вес выбранной кости на этой вершине
                let w = 0;
                for (let s = 0; s < 4; s++) {
                    if (si.array[i * 4 + s] === idx) w += sw.array[i * 4 + s];
                }
                // серый (нет влияния) → красный (полное влияние)
                const t = Math.min(w, 1);
                colors[i * 3]     = 0.25 + 0.75 * t;
                colors[i * 3 + 1] = 0.25 + 0.15 * t;
                colors[i * 3 + 2] = 0.25 + 0.15 * t;
            }
            geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

            const mat = new THREE.MeshBasicMaterial({ vertexColors: true, skinning: true });
            this.override(o, mat);
            this.influenceMeshes.push(o);
        });
    }

    clearInfluence() {
        this.influenceMeshes.forEach(o => this.restore(o));
        this.influenceMeshes = [];
    }

    // ---------- Материалы: переопределение/возврат ----------
    override(mesh, mat) {
        if (!this.origMaterials.has(mesh)) {
            this.origMaterials.set(mesh, mesh.material);
        }
        mesh.material = mat;
    }

    restore(mesh) {
        if (this.origMaterials.has(mesh)) {
            mesh.material = this.origMaterials.get(mesh);
            this.origMaterials.delete(mesh);
        }
    }

    restoreAll() {
        [...this.origMaterials.keys()].forEach(m => this.restore(m));
    }

    // Применяем флаг wireframe к материалу (или массиву материалов)
    applyWireframe(mat, on) {
        (Array.isArray(mat) ? mat : [mat]).forEach(m => {
            if (m && 'wireframe' in m) m.wireframe = on;
        });
    }

    eachMesh(fn) {
        if (!this.model) return;
        this.model.traverse(o => { if (o.isMesh) fn(o); });
    }

    // ---------- Текстуры: собираем слоты ----------
    collectTextures() {
        const out = [];
        const seen = new Set();
        this.eachMesh(o => {
            (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
                if (!m) return;
                TEX_SLOTS.forEach(([slot, label]) => {
                    const tex = m[slot];
                    if (tex && tex.isTexture && !seen.has(tex.uuid)) {
                        seen.add(tex.uuid);
                        out.push({ label, slot, tex });
                    }
                });
            });
        });
        return out;
    }

    // ---------- Вкл/выкл режимов ----------
    setMode(key, on) {
        this.modes[key] = on;

        switch (key) {
            case 'noPost':
                // «No post-processing» = сырое изображение без tone mapping
                this.renderer.toneMapping = on ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
                break;

            case 'autorotate':
                this.controls.autoRotate = on;
                break;

            case 'wireframe':
                this.eachMesh(o => this.applyWireframe(o.material, on));
                break;

            case 'normals':
                // Нормали вертексов: MeshNormalMaterial красит поверхность по нормалям
                if (on) {
                    this.clearInfluence();
                    this.eachMesh(o => {
                        const mat = new THREE.MeshNormalMaterial({ skinning: true });
                        this.override(o, mat);
                    });
                    this.eachMesh(o => this.applyWireframe(o.material, this.modes.wireframe));
                } else {
                    this.restoreAll();
                }
                break;

            case 'bones':
                this.setBonesVisible(on);
                if (!on) this.selectBone(null);
                else if (this.selectedBone) this.showInfluence(this.selectedBone);
                break;
        }
    }
}

// Глобально для script.js (классические скрипты, не модули)
window.ModelStage = ModelStage;
