/** 在真实桌面入口验收启动提醒，所有原生检查、下载和安装均使用合成回执。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STARTUP_TEST_URL || 'http://127.0.0.1:5197';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const notes = [
  '三店同步更新成本和库存',
  '「价格与利润」与「写配置」实时双向同步',
  ...Array.from({ length: 14 }, (_, index) => `补充更新说明 ${index + 1}`),
];
const release = {
  currentVersion: '0.2.50',
  version: '9.9.0',
  available: true,
  canInstall: true,
  source: 'Gitea',
  message: '可用',
  notes: notes.map(note => `- ${note}`).join('\r\n'),
};
const errors = [];
const scenarios = ['light', 'dark', 'small', 'view-only', 'current', 'offline', 'manual'];

async function openManualUpdate(page) {
  await page.locator('.app-more summary').click();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('dialog', { name: '检查更新' }).waitFor();
}

async function checkCardLayout(page, notice, dark) {
  const box = await notice.boundingBox();
  const { width, height } = page.viewportSize();
  assert.equal(box.width, Math.min(420, width - 28));
  assert.ok(Math.abs(box.x + box.width / 2 - width / 2) <= 1, '横向居中');
  assert.ok(Math.abs(box.y + box.height / 2 - height / 2) <= 1, '纵向居中');

  const style = await notice.evaluate(element => {
    const card = getComputedStyle(element);
    const backdrop = getComputedStyle(element, '::backdrop');
    const header = getComputedStyle(element.querySelector('header'));
    const badge = getComputedStyle(element.querySelector('.startup-update-current'));
    const primary = getComputedStyle(element.querySelector('.startup-update-primary'));
    const retention = getComputedStyle(element.querySelector('.startup-update-retention'));
    return {
      modal: element.matches(':modal'),
      radius: card.borderRadius,
      borderWidth: card.borderTopWidth,
      borderColor: card.borderTopColor,
      panel: card.backgroundColor,
      text: card.color,
      retention: retention.color,
      dim: backdrop.backgroundColor,
      blur: backdrop.backdropFilter,
      header: header.backgroundColor,
      title: header.color,
      badge: badge.backgroundColor,
      badgeText: badge.color,
      primary: primary.backgroundColor,
      primaryText: primary.color,
    };
  });
  const ink = 'rgb(24, 26, 25)', yellow = 'rgb(243, 241, 52)';
  assert.deepEqual(style, {
    modal: true,
    radius: '12px',
    borderWidth: '2px',
    borderColor: dark ? yellow : ink,
    panel: dark ? 'rgb(34, 36, 32)' : 'rgb(255, 255, 255)',
    text: dark ? 'rgb(244, 246, 242)' : ink,
    retention: dark ? 'rgb(168, 176, 169)' : 'rgb(85, 93, 87)',
    dim: dark ? 'rgba(0, 0, 0, 0.52)' : 'rgba(0, 0, 0, 0.32)',
    blur: 'blur(1.5px)',
    header: yellow,
    title: ink,
    badge: ink,
    badgeText: yellow,
    primary: dark ? yellow : ink,
    primaryText: dark ? ink : yellow,
  });
}

try {
  for (const scenario of scenarios) {
    const dark = scenario === 'dark';
    const page = await browser.newPage({
      viewport: scenario === 'small' ? { width: 360, height: 480 } : { width: 960, height: 640 },
    });
    page.on('pageerror', error => errors.push(`${scenario}: ${error.message}`));
    try {
      const calls = [];
      const check = Promise.withResolvers();
      const download = Promise.withResolvers();
      const install = Promise.withResolvers();
      await page.exposeFunction('fixtureInvoke', async command => {
        calls.push(command);
        const reply = body => ({ status: 200, body: JSON.stringify(body) });
        if (command === 'nas_native_request') return reply({ main_editor: false, acceptance: false });
        if (command === 'cloud_native_json_request') return reply({ configured: false });
        if (command === 'updater_check') {
          await check.promise;
          if (scenario === 'offline') throw Error('离线验收');
          if (scenario === 'current') return { ...release, available: false, canInstall: false, version: null };
          if (scenario === 'view-only') return { ...release, canInstall: false, notes: ' \r\n ' };
          return release;
        }
        if (command === 'plugin:app|version') return release.currentVersion;
        if (command === 'plugin:event|listen') return 1;
        if (command === 'updater_download') return download.promise;
        if (command === 'updater_install') install.resolve();
        return null;
      });
      await page.addInitScript(theme => {
        let next = 0;
        localStorage.setItem('diytools.workbench.endfield.theme.v1', theme);
        window.isTauri = true;
        window.__TAURI_INTERNALS__ = {
          invoke: (command, args) => window.fixtureInvoke(command, args),
          transformCallback: () => ++next,
          metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        };
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      }, dark ? 'dark' : 'light');
      await page.route('**/workbench/index.html*', route => route.fulfill({
        contentType: 'text/html',
        body: `<html><body>合成编辑区<script>
          window.workbenchBeforeQuit = () => window.fixtureInvoke('fixture_save');
          window.workbenchHasPendingChanges = () => false;
        </script></body></html>`,
      }));
      await page.goto(base + '/');
      const notice = page.getByRole('dialog', { name: '发现新版本 · v9.9.0' });
      const updateDialog = page.getByRole('dialog', { name: '检查更新' });
      await page.locator('.legacy-workbench-frame').waitFor();
      assert.equal(calls.filter(command => command === 'updater_check').length, 1);
      assert.equal(await notice.count(), 0);
      if (scenario === 'manual') await openManualUpdate(page);
      check.resolve();

      if (scenario === 'current' || scenario === 'offline') {
        // 等待原生回执和 React 渲染，确认无更新或离线时保持工作台可用。
        await page.waitForTimeout(150);
        assert.equal(await notice.count(), 0);
      } else if (scenario === 'manual') {
        await updateDialog.getByText('可用', { exact: true }).waitFor();
        assert.equal(await notice.count(), 0);
      } else {
        await notice.waitFor();
        await notice.getByText('当前 v0.2.50', { exact: true }).waitFor();
        await notice.getByText('仅原地替换主程序并自动重启，草稿、账号与数据全部保留。').waitFor();
        await checkCardLayout(page, notice, dark);
        assert.ok(!calls.includes('updater_download'), '显示提醒时不启动下载');

        const later = notice.getByRole('button', { name: '稍后再说' });
        assert.equal(await later.evaluate(element => element === document.activeElement), true);
        if (scenario === 'view-only') {
          await notice.getByText('新版本已可用。打开更新窗口可查看详细信息。').waitFor();
          await notice.getByRole('button', { name: '查看更新' }).click();
          await updateDialog.getByText('可用', { exact: true }).waitFor();
        } else {
          const list = notice.getByRole('list', { name: '本次更新重点' });
          assert.deepEqual(await list.getByRole('listitem').allTextContents(), notes);
          assert.equal(await list.evaluate(element => element.scrollHeight > element.clientHeight), true);
          if (scenario === 'light') {
            await later.click();
          } else if (scenario === 'dark') {
            await page.keyboard.press('Escape');
          } else {
            await notice.getByRole('button', { name: '立即更新并重启' }).click();
            await updateDialog.getByRole('progressbar', { name: '更新包下载进度' }).waitFor();
            download.resolve({ version: release.version, source: release.source });
            await Promise.race([
              install.promise,
              updateDialog.getByText('正在保存修改并准备重启，请稍候…').waitFor({ timeout: 5000 }).then(async () => {
                await updateDialog.getByRole('alert').waitFor({ timeout: 5000 });
                throw Error(await updateDialog.getByRole('alert').textContent());
              }),
            ]);
            assert.deepEqual(calls.filter(command => ['updater_download', 'fixture_save', 'updater_install'].includes(command)),
              ['updater_download', 'fixture_save', 'updater_install']);
          }
        }
        await notice.waitFor({ state: 'detached' });
        if (scenario === 'light' || scenario === 'dark') {
          await openManualUpdate(page);
          await updateDialog.getByText('可用', { exact: true }).waitFor();
          await updateDialog.getByRole('button', { name: '关闭更新窗口' }).click();
        }
        assert.equal(await notice.count(), 0);
      }
      const manualAfterDismiss = scenario === 'light' || scenario === 'dark';
      assert.equal(calls.filter(command => command === 'updater_check').length, manualAfterDismiss ? 2 : 1);
      if (scenario !== 'small') assert.ok(!calls.includes('updater_download') && !calls.includes('updater_install'));
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, scenarios }));
} finally {
  await browser.close();
}
