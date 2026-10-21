// Source only, UNRUN. Called by the sole 6srs driver after its real DOM,
// reviewed JSX/JSON loader and final source/dependency manifest checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const componentSourcePins = Object.freeze({
  "frontend/src/components/MessageList.jsx": "6dec1fc97a120ff7a7fbdcc28ac290e1c6ccb3024164904eac7828ee52451bcb",
  "frontend/src/components/ReadingPane.jsx": "4dff1e56cb127fe5b312198224602b5fad5c7e4d3aa3d0d197a8a5ce1d39a0c6",
  "frontend/src/components/ConversationPane.jsx": "fff1b390045ce3e5c351d744e11b5825d5af015005b88fd75c88a9e3473715af",
  "frontend/src/components/MessagePane.jsx": "00ab456ec5a7b1cc5e939548569d189dd2a9c9ce785a622bf955fc4391986bf7",
  "frontend/src/components/MessageBodyView.jsx": "5efd2740ea7948cecf41ce42fd0c1364577e7555a0198b756ab35ec775db2c01",
  "frontend/src/components/ComposeModal.jsx": "1aa6083ef560a733059fe6f35956bf8b99f3f06e74c66accc3f134b8c35454fc",
  "frontend/src/store/index.js": "c50b546428ba9b76f54f262eb29962080153479b08f8ae77dac233f7222e9976",
  "frontend/src/store/countReconciliation.js": "9056126fa7fec591d67e658166cc8020b6a471685ab7e34c30f1df58bdf574aa",
  "frontend/src/utils/api.js": "eaaad7f044848e1242e86e8fc7feed3232004f77b1c67a6b977766b00a90d4f2",
  "frontend/src/utils/bodyCache.js": "42b97201d2aa00013bbe4ed0be4451b312609bb3ca77f997cc64621f48298126",
  "frontend/src/utils/countWriteTracker.js": "1576921a8d8aaa45cc9fa9509d36c77fc97506e08905b43c753748d9e2377d27",
  "frontend/src/utils/pendingReads.js": "4e91a5b418014488e5bfb8c56340658fec36cde71e2050541e8331d9528e136b",
  "frontend/src/utils/composeFromMessage.js": "e7effc1dd4c5499bc11ef7d796f79860ab159a42abb5c3e42b94d34904c981ca",
  "frontend/src/i18n.js": "6559d6656ba78c5c28cfb5dda7d6af5a4cfec1867cebbbb4242c71b9b7842dcc"
});

export async function loadActualComponentBindings({ productionRoot }) {
  assert(path.isAbsolute(productionRoot), 'Bind the materialized final same-app source root');
  const root = fs.realpathSync(productionRoot);
  assert(globalThis.document?.body && globalThis.window?.document === globalThis.document,
    'The sole driver must install the actual JSDOM document before product imports');
  for (const [relative, expected] of Object.entries(componentSourcePins)) {
    const file = path.join(root, relative);
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected, relative);
  }
  // Resolve dependencies from the product frontend, never from this artifact's
  // directory. The driver owns verification of their installed/lock closure.
  const frontend = path.join(root, 'frontend');
  const require = createRequire(path.join(frontend, 'package.json'));
  const React = await import(pathToFileURL(require.resolve('react')).href);
  const { createRoot } = await import(pathToFileURL(require.resolve('react-dom/client')).href);
  const load = relative => import(pathToFileURL(path.join(root, relative)).href);
  const { default: i18n, i18nReady } = await load('frontend/src/i18n.js');
  await i18nReady;
  const { useStore } = await load('frontend/src/store/index.js');
  const { api } = await load('frontend/src/utils/api.js');
  const { bodyCache } = await load('frontend/src/utils/bodyCache.js');
  const { countWriteTracker } = await load('frontend/src/utils/countWriteTracker.js');
  const { default: MessageList } = await load('frontend/src/components/MessageList.jsx');
  const { default: ReadingPane } = await load('frontend/src/components/ReadingPane.jsx');
  const { default: ComposeModal } = await load('frontend/src/components/ComposeModal.jsx');
  // store/index.js installs its actual bindCountReconciliation at module scope.
  // No additional binder, query, body transport, count callback or state helper
  // is substituted here. bindNanaWire imports the real backend db.query itself.
  return Object.freeze({ React, createRoot, MessageList, ReadingPane, ComposeModal,
    useStore, api, bodyCache, countWriteTracker, i18n });
}
