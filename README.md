# ModelForge

Веб-редактор для 3D-моделей: открыть модель, посмотреть скелет, поставить блоки-аттачменты на кости, записать простую анимацию и экспортировать JSON для своей игры.

Работает в браузере, без сервера. Телефон и ПК, вертикальная и горизонтальная ориентация.

## Что умеет (v0.1)

- **Открытие моделей:** glTF/GLB (основной формат), FBX, OBJ (+MTL), COLLADA (.dae). Текстуры подтягиваются, если выбрать модель вместе с файлами текстур или .bin.
- **Просмотр:** вращение, масштаб, панорамирование (мышь, тач, щипок). Кнопки «+» и «−», «Кадр» возвращает камеру к модели.
- **Кости:** список костей в левой панели, показ и скрытие скелета, поворот выбранной кости по осям X/Y/Z относительно покоя.
- **Блоки (аттачменты):** оранжевые маркеры со стрелкой направления. Видны только в редакторе. Перетаскиваются через гизмо. Отпустил рядом с костью, они привязываются к ней. Имя задаётся в правой панели.
- **Анимация:** таймлайн, scrub, play/pause, режим Loop или однократный. Ключи записываются по кнопке «● Ключ» со всеми костями в текущей позе. Можно играть готовые клипы из файла.
- **Экспорт:** блоки в JSON (имя, кость, положение относительно кости) и анимация в формате three.js `AnimationClip`.

## Что пока не умеет

- Создание новых костей. Работаем только с тем, что есть в модели.
- Ключи для позиции костей. Сейчас ключуется только поворот.
- Импорт экспортированных JSON обратно в редактор.
- Сохранение проекта между сессиями. Всё живёт в открытой вкладке.

## Запуск

ES-модули не работают через `file://`, поэтому нужен любой локальный сервер:

```bash
cd modelforge
python3 -m http.server 8000
```

Потом открыть http://localhost:8000. Нужен интернет: three.js подтягивается с CDN jsDelivr.

## Публикация на GitHub Pages

```bash
cd modelforge
git init
git add .
git commit -m "ModelForge v0.1"
gh repo create modelforge --public --source=. --push
```

Затем в репозитории: Settings → Pages → Source: `Deploy from a branch`, branch `main`, folder `/ (root)`.

## Как использовать экспорт в игре

```js
import * as THREE from 'three';

// Анимация
const animJson = await (await fetch('hero.idle.animation.json')).json();
const clip = THREE.AnimationClip.parse(animJson);
const mixer = new THREE.AnimationMixer(model);
mixer.clipAction(clip).play();

// Блоки
const att = await (await fetch('hero.attachments.json')).json();
for (const a of att.attachments) {
  // Кость по пути вида "Armature/Hips/Spine"
  const bone = a.bone ? model.getObjectByName(a.bone.split('/').pop()) : model;
  const point = new THREE.Object3D();
  point.name = a.name;
  point.position.fromArray(a.position);
  point.quaternion.fromArray(a.quaternion);
  point.scale.fromArray(a.scale);
  bone.add(point);            // потом: model.getObjectByName('weapon_grip')
}
```

Для точного поиска кости по полному пути используй `a.bone` и обходи родителей, либо держи в игре словарь имён костей.

## Структура

```
modelforge/
├── index.html      разметка и импорт three.js
├── css/style.css   стили (светлая и тёмная тема, мобильная раскладка)
├── js/app.js       вся логика: загрузка, сцена, кости, блоки, анимация, экспорт
└── README.md
```
