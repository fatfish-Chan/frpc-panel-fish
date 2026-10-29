// 打包后瘦身：只留中英文语言包，去掉没用的许可证文件
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const dir = context.appOutDir;
  const drop = [
    'LICENSES.chromium.html',
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll',
  ];
  for (const f of drop) {
    const p = path.join(dir, f);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  const locDir = path.join(dir, 'locales');
  const keep = new Set(['zh-CN.pak', 'en-US.pak', 'zh-TW.pak']);
  try {
    for (const f of fs.readdirSync(locDir)) {
      if (!keep.has(f)) fs.rmSync(path.join(locDir, f), { force: true });
    }
  } catch (e) { /* ignore */ }
  console.log('[afterPack] 瘦身完成：', fs.readdirSync(locDir).join(', '));
};
