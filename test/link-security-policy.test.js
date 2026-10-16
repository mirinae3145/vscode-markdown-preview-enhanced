/* global suite, test, suiteSetup, suiteTeardown, setup */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const {
  recorder,
  stubPlugin,
  setConfigurationScopes,
  setWorkspaceFolderResolver,
  setWorkspaceFolders,
} = require('./vscode-stub');

let bundle;
let tmpFile;
const context = () => ({
  subscriptions: [],
  extensionUri: bundle.Uri.file('/ext'),
  extensionPath: '/ext',
  extensionMode: 1,
  globalStorageUri: bundle.Uri.file('/storage'),
  globalState: { get: () => undefined, update: async () => {} },
  workspaceState: { get: () => undefined, update: async () => {} },
});

suite('custom preview link permissions', function () {
  this.timeout(30000);

  suiteSetup(async function () {
    const result = await esbuild.build({
      stdin: {
        contents: [
          "export { initExtensionCommon } from './src/extension-common';",
          "export { default as NotebooksManager } from './src/notebooks-manager';",
          "export { getAdditionalLinkSchemes, previewLinkAction } from './src/link-security-policy';",
          "export { Uri } from 'vscode';",
        ].join('\n'),
        resolveDir: path.join(__dirname, '..'),
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      plugins: [stubPlugin()],
    });
    tmpFile = path.join(__dirname, '.link-security-policy.bundle.cjs');
    fs.writeFileSync(tmpFile, result.outputFiles[0].text);
    bundle = require(tmpFile);
    setConfigurationScopes({ global: { markdownFileExtensions: ['.md'] } });
    await bundle.initExtensionCommon(context());
  });

  suiteTeardown(function () {
    if (tmpFile) fs.unlinkSync(tmpFile);
  });

  setup(function () {
    recorder.openedExternal = [];
    setConfigurationScopes({});
    const folder = { uri: bundle.Uri.file('/ws'), name: 'ws', index: 0 };
    setWorkspaceFolders([folder]);
    setWorkspaceFolderResolver(() => folder);
  });

  test('passes only normalized user permissions to Notebook.init', async function () {
    setConfigurationScopes({
      global: { additionalLinkSchemes: ['ZOTERO', 'zotero', 'obsidian'] },
      workspace: { additionalLinkSchemes: ['command', 'evil'] },
    });
    const manager = new bundle.NotebooksManager(context());
    const notebook = await manager.getNotebook(bundle.Uri.file('/ws/a.md'));
    assert.deepStrictEqual(notebook.securityPolicy, {
      additionalLinkSchemes: ['zotero', 'obsidian'],
    });
  });

  test('workspace-only permissions do not reach the notebook', async function () {
    setConfigurationScopes({
      workspace: { additionalLinkSchemes: ['zotero'] },
    });
    const notebook = await new bundle.NotebooksManager(context()).getNotebook(
      bundle.Uri.file('/ws/a.md'),
    );
    assert.deepStrictEqual(notebook.securityPolicy.additionalLinkSchemes, []);
  });

  test('ignores malformed and reserved user entries', function () {
    setConfigurationScopes({
      global: {
        additionalLinkSchemes: [
          'javascript',
          'VBSCRIPT',
          'data',
          'command',
          'blob',
          'filesystem',
          'file',
          'zotero:',
          'zotero\n',
          '.*',
          null,
          7,
          'obsidian',
        ],
      },
    });
    assert.deepStrictEqual(bundle.getAdditionalLinkSchemes(), ['obsidian']);
    setConfigurationScopes({ global: { additionalLinkSchemes: 'zotero' } });
    assert.deepStrictEqual(bundle.getAdditionalLinkSchemes(), []);
  });

  test('opens approved custom links through VS Code, including PDF paths', async function () {
    setConfigurationScopes({ global: { additionalLinkSchemes: ['zotero'] } });
    await recorder.commands.get('_crossnote.clickTagA')({
      uri: 'file:///ws/a.md',
      scheme: 'file',
      href: encodeURIComponent('zotero://open-pdf/library/items/ABC/paper.pdf'),
    });
    assert.strictEqual(recorder.openedExternal.length, 1);
    assert.strictEqual(recorder.openedExternal[0].scheme, 'zotero');
  });

  test('checks current permissions again when a link is clicked', async function () {
    setConfigurationScopes({ global: { additionalLinkSchemes: ['zotero'] } });
    const notebook = await new bundle.NotebooksManager(context()).getNotebook(
      bundle.Uri.file('/ws/a.md'),
    );
    assert.deepStrictEqual(notebook.securityPolicy.additionalLinkSchemes, [
      'zotero',
    ]);
    setConfigurationScopes({});
    await recorder.commands.get('_crossnote.clickTagA')({
      uri: 'file:///ws/a.md',
      scheme: 'file',
      href: encodeURIComponent('zotero://open/item'),
    });
    assert.deepStrictEqual(recorder.openedExternal, []);
  });

  test('blocks dangerous decoded links and ignores malformed escapes', async function () {
    for (const href of [
      'javascript:alert(1)',
      'command:workbench.action.closeWindow',
      'java\tscript:alert(1)',
      'data:text/html,bad',
      'unknown://open',
    ]) {
      assert.strictEqual(bundle.previewLinkAction(href, 'file'), 'blocked');
      await recorder.commands.get('_crossnote.clickTagA')({
        uri: 'file:///ws/a.md',
        scheme: 'file',
        href: encodeURIComponent(href),
      });
    }
    await recorder.commands.get('_crossnote.clickTagA')({
      uri: 'file:///ws/a.md',
      scheme: 'file',
      href: '%',
    });
    assert.deepStrictEqual(recorder.openedExternal, []);
  });

  test('a custom source scheme cannot grant permission', function () {
    assert.strictEqual(
      bundle.previewLinkAction('zotero://open', 'zotero'),
      'blocked',
    );
  });

  test('retains standard web and local file handling', function () {
    for (const href of [
      'https://example.com',
      'mailto:a@example.com',
      'file:///ws/note.md',
      'note.md',
    ]) {
      assert.strictEqual(bundle.previewLinkAction(href, 'file'), 'default');
    }
  });

  test('setting is user-only and defaults to no extra permissions', function () {
    const setting =
      require('../package.json').contributes.configuration.properties[
        'markdown-preview-enhanced.additionalLinkSchemes'
      ];
    assert.strictEqual(setting.scope, 'application');
    assert.deepStrictEqual(setting.default, []);
  });
});
