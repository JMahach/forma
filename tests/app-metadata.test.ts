import test from 'node:test';
import assert from 'node:assert/strict';
import { appMetadataAttributes, normalizeAppMetadata } from '../shared/app-metadata.ts';

test('the server attributes have one canonical format and strip back to the build shell', () => {
 const attrs=appMetadataAttributes({environment:'production',appVersion:'0.2+abc'});
 const shell='<html><body><main>Forma</main></body></html>';
 assert.equal(normalizeAppMetadata(shell.replace('<body>','<body'+attrs+'>')),shell);
 assert.equal(normalizeAppMetadata(shell),shell);
 assert.match(attrs,/data-app-environment="production"/);
 assert.doesNotMatch(attrs,/calculation|cycles/);
 assert.equal(appMetadataAttributes({environment:'stand'}),' data-app-name="Форма 1"');
 assert.match(appMetadataAttributes({environment:'stand',standNumber:'4'}),/data-app-name="Форма 4"/);
 assert.match(appMetadataAttributes({environment:'production',standNumber:'4'}),/data-app-name="Форма"/);
});
test('invalid metadata and duplicate runtime attributes never disappear from integrity checking', () => {
 assert.throws(()=>appMetadataAttributes({environment:'wrong' as 'stand'}));
 assert.throws(()=>appMetadataAttributes({appVersion:'<script>'}));
 for(const standNumber of ['0','01','-1','<script>','2\" onclick=\"x'])assert.throws(()=>appMetadataAttributes({standNumber}));
 for(const attrs of [' data-app-version="a" data-app-version="b"', ' data-app-environment="wrong"', ' data-app-name="Форма 0"', ' data-app-name="Форма 1" data-app-name="Форма 2"']){
  assert.throws(()=>normalizeAppMetadata('<body'+attrs+'>x</body>'));
 }
 const extra='<body data-personal-account="1">x</body>';
 assert.equal(normalizeAppMetadata(extra),extra,'unknown attributes remain in the digest input');
 assert.equal(normalizeAppMetadata('<body class="shell"'+appMetadataAttributes({appVersion:'v1'})+'>x</body>'),'<body class="shell">x</body>');
});

test('metadata-looking text inside unrelated quoted values stays byte-for-byte intact',()=>{
 const shell=`<body data-note='prefix data-app-version="v2" suffix'>x</body>`;
 assert.equal(normalizeAppMetadata(shell),shell);
 const withMetadata=shell.replace('>',' data-app-version="v3">');
 assert.equal(normalizeAppMetadata(withMetadata),shell);
 const greater='<body title="a > b" data-app-version="v4">x</body>';
 assert.equal(normalizeAppMetadata(greater),'<body title="a > b">x</body>');
});
