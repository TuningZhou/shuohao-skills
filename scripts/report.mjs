#!/usr/bin/env node
/**
 * report.mjs —— 把 novel 系列各 skill 的报告合成一张单页，左侧导航切换。
 *
 * 定位：**组装器，不是第六个 skill**。它不 import 任何 skill 的代码，而是调各自的
 * `render --html` 拿产物再拼装。三条好处：
 *
 *   1. 六个 skill 一行不改，各自仍然独立可跑、可以单独拷走
 *   2. 各 skill 的加载逻辑（图存在才挂、ctx 组装、语言优先级）只有一份，不在这里重写
 *   3. 某个 skill 改了渲染，这里自动跟上，不会漂
 *
 * 合并要解决三件事，都在这个文件里做，不侵入 skill：
 *
 *   - **样式串味**：五份报告共用 57 个类名，其中 13 个同名不同定义（`.copy` `.kpis`
 *     `.badge` `.chip` …）。做法是给每份样式的每条选择器加作用域前缀。
 *     已量过：五份报告的 CSS 里**没有任何 `#id` 选择器**，所以只处理类与元素选择器。
 *   - **脚本串味**：各报告的脚本都是 `document.querySelector('.expo')` 这种全局查询。
 *     合成一页后只会命中第一个——五个导出按钮会全废。做法是给每份脚本套一层
 *     作用域代理，把查询限制在自己的 pane 内。
 *   - **图片路径**：各报告的图相对自己那份 json 的目录（`images/…`、`E01-01/f1.png`）。
 *     合成后要按输出文件的位置重算。
 *
 * 用法见 USAGE。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(here, '..', 'skills');

/* ------------------------------------------------------------------ */
/* 面板定义                                                            */
/* ------------------------------------------------------------------ */

/**
 * 顺序照流程图：大纲 → （角色 · 美术 · 剧本）→ 分镜。
 *
 * `needs` 是这份报告渲染时要一并喂进去的上游——合并器手上有全部路径，
 * 顺手传给各自的 render，用户不用自己拼一长串参数。分镜的 `--script`
 * 是硬前提（没有剧本它会直接报错），其余都是可选增强。
 *
 * `dir` 是端到端 demo 工作目录约定里对应的子目录名，`--from` 自动发现时用。
 */
export const PANES = [
  {
    id: 'outline',
    skill: 'novel-outline',
    flag: '--outline',
    dir: 'outline',
    label: '大纲',
    labelEn: 'Outline',
    hint: '改编结构与分集',
    hintEn: 'Adaptation & episodes',
    needs: [],
  },
  {
    id: 'characters',
    skill: 'novel-characters',
    flag: '--cast',
    dir: 'characters',
    label: '角色',
    labelEn: 'Characters',
    hint: '画像与设定图',
    hintEn: 'Profiles & sheets',
    needs: [],
  },
  {
    id: 'refs',
    skill: 'character-refs',
    flag: '--refs',
    dir: 'refs',
    label: '定妆',
    labelEn: 'Refs',
    hint: '多视角参考图册',
    hintEn: 'Multi-view turnarounds',
    needs: ['--cast'],
  },
  {
    id: 'art',
    skill: 'novel-art',
    flag: '--art',
    dir: 'art',
    label: '美术',
    labelEn: 'Art',
    hint: '场景与道具',
    hintEn: 'Scenes & props',
    needs: ['--cast'],
  },
  {
    id: 'script',
    skill: 'novel-script',
    flag: '--script',
    dir: 'script',
    label: '剧本',
    labelEn: 'Screenplay',
    hint: '场次、节拍、台词',
    hintEn: 'Scenes, beats, lines',
    needs: ['--outline', '--art', '--cast'],
  },
  {
    id: 'staging',
    skill: 'novel-staging',
    flag: '--staging',
    dir: 'staging',
    label: '站位',
    labelEn: 'Staging',
    hint: '开场平面调度',
    hintEn: 'Blocking & positions',
    needs: ['--script', '--art', '--outline'],
  },
  {
    id: 'storyboard',
    skill: 'novel-storyboard',
    flag: '--storyboard',
    dir: 'storyboard',
    label: '分镜',
    labelEn: 'Storyboard',
    hint: '段、分镜、首帧',
    hintEn: 'Segments, cuts, frames',
    needs: ['--script', '--outline', '--art', '--cast'],
  },
];

/* ------------------------------------------------------------------ */
/* 拆文档                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把一份完整 HTML 文档拆成 { style, body, scripts, title }。
 *
 * 各报告都是 `<!doctype html><html><head><style>…</style></head><body>…</body></html>`
 * 这个固定形状，所以正则够用——不引入 DOM 解析器，这个仓库零依赖。
 */
export function splitDoc(html) {
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);

  // **只抠真正的 JavaScript**。各报告都用 `<script type="application/json" id="…-data">`
  // 内嵌自己那份源 JSON 给导出按钮读——那是数据不是脚本，必须原样留在正文里。
  // 抠错了会被当成代码执行，浏览器直接甩 `Unexpected token ':'`。
  const isJs = (attrs) => {
    if (/\bsrc=/.test(attrs)) return false;
    const type = (attrs.match(/\btype="([^"]*)"/) ?? [])[1];
    return !type || /^(text\/javascript|module|application\/javascript)$/i.test(type);
  };
  const SCRIPT_RE = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  const scripts = [...html.matchAll(SCRIPT_RE)].filter((m) => isJs(m[1])).map((m) => m[2]);

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/);
  let body = bodyMatch ? bodyMatch[1] : html;
  // 正文里把 JS 剥掉（它们要单独套作用域），数据块留下
  body = body.replace(SCRIPT_RE, (whole, attrs) => (isJs(attrs) ? '' : whole));
  const title = (html.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '';
  return { style: styles.join('\n'), body, scripts, title };
}

/* ------------------------------------------------------------------ */
/* 样式加作用域                                                        */
/* ------------------------------------------------------------------ */

/**
 * 给一份样式表的每条选择器加上作用域前缀。
 *
 * 四种要特殊对待的：
 *   - `:root` / `html` / `body` → 直接换成作用域本身（自定义属性挂在 pane 上，
 *     pane 内部照常继承）
 *   - `@keyframes` → **整块原样保留**，里面的 `0%` `from` `to` 不是选择器
 *   - `@media` / `@supports` → 递归处理内部，`@` 行本身不动
 *   - 逗号分隔的选择器组 → 每一支各自加前缀
 */
export function scopeCss(css, scope) {
  // 先剥注释。规则之间的注释会被当成下一条选择器的一部分，而注释里的逗号会把
  // 选择器切断——实测 `/* episode overview: first three cards, … */` 就是这么
  // 变成一条选择器的。剥掉是最省事的解，合并产物里也不需要这些注释。
  const css2 = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0;

  const readBlock = (from) => {
    // 从 `{` 开始配对到对应的 `}`，返回结束位置（指向 `}` 之后）
    let depth = 0;
    for (let k = from; k < css2.length; k += 1) {
      if (css2[k] === '{') depth += 1;
      else if (css2[k] === '}') {
        depth -= 1;
        if (depth === 0) return k + 1;
      }
    }
    return css2.length;
  };

  while (i < css2.length) {
    const brace = css2.indexOf('{', i);
    if (brace < 0) { out.push(css2.slice(i)); break; }
    const head = css2.slice(i, brace).trim();
    const end = readBlock(brace);
    const inner = css2.slice(brace + 1, end - 1);

    if (/^@(keyframes|font-face|counter-style|property)/i.test(head)) {
      // 动画关键帧与字体声明整块原样搬，内部不是选择器
      out.push(`${head}{${inner}}`);
    } else if (/^@(media|supports|layer|container)/i.test(head)) {
      out.push(`${head}{${scopeCss(inner, scope)}}`);
    } else if (head.startsWith('@')) {
      out.push(`${head}{${inner}}`);
    } else {
      const scoped = head
        .split(',')
        .map((sel) => {
          const s = sel.trim();
          if (!s) return '';
          // 页面级选择器换成作用域本身：自定义属性与基础排版落在 pane 上
          if (/^(:root|html|body)$/.test(s)) return scope;
          if (/^(:root|html|body)\b/.test(s)) return s.replace(/^(:root|html|body)\b/, scope);
          // `*` 单独一支时不加空格，避免选中 pane 自己以外的东西时语义漂移
          return `${scope} ${s}`;
        })
        .filter(Boolean)
        .join(',');
      out.push(`${scoped}{${inner}}`);
    }
    i = end;
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* 正文加作用域                                                        */
/* ------------------------------------------------------------------ */

/**
 * 给正文里的 id 加前缀，并同步改掉引用它的地方。
 *
 * 已量过：五份报告跨文档重复的 id 有 9 个（`#ep-1`…`#ep-6`、`#sec-gates`、
 * `#sec-scenes`、`#sec-rhythm`）。不改的话页内锚点会跳到别的面板去。
 *
 * 一并改的引用点：`href="#…"`、`data-pane="…"`（大纲的图表/表格切换靠它跟
 * `p.id` 比对）、`aria-controls`、`for`。**脚本里的 id 字符串不用改**——
 * 作用域代理会在 `getElementById` 里自动补前缀。
 */
export function scopeHtml(body, prefix) {
  return body
    .replace(/(^|[\s<])id="([^"]+)"/g, (_, p, id) => `${p}id="${prefix}${id}"`)
    .replace(/\bhref="#([^"]+)"/g, (_, id) => `href="#${prefix}${id}"`)
    .replace(/\bdata-pane="([^"]+)"/g, (_, id) => `data-pane="${prefix}${id}"`)
    .replace(/\bdata-target="([^"]+)"/g, (_, id) => `data-target="${prefix}${id}"`)
    .replace(/\baria-controls="([^"]+)"/g, (_, id) => `aria-controls="${prefix}${id}"`)
    .replace(/(^|[\s<])for="([^"]+)"/g, (_, p, id) => `${p}for="${prefix}${id}"`);
}

/**
 * 把相对图片路径按输出文件的位置重算。
 *
 * 各报告的图相对各自 json 所在目录（角色是 `images/…`，分镜是 `E01-01/f1.png`）。
 * 合成一页之后，浏览器按合并文件的位置解析，不重算就全是断图。
 * `data:` 与绝对地址原样不动。
 *
 * 同时将 `loading="lazy"` 转为 `loading="eager"`，避免在分栏/多标签页初始隐藏
 * (display: none) 下被现代浏览器（尤其是 Safari / WebKit 与部分 Chromium 内核）
 * 挂起懒加载判定导致切到该面板时不显图的顽疾。
 */
export function rebaseAssets(text, fromDir, outDir) {
  const fix = (p) => {
    if (!p || /^(data:|https?:|file:|\/|#)/i.test(p)) return p;
    const rel = relative(outDir, resolve(fromDir, p)).split('\\').join('/');
    return rel || p;
  };
  return text
    .replace(/\b(src|data-img|data-src|poster)="([^"]*)"/g, (m, attr, val) => `${attr}="${fix(val)}"`)
    .replace(/\bdata-ab-asset="([^"]*)"/g, (m, val) => `data-ab-asset="${fix(val)}"`)
    .replace(/\bdata-ab-versions="([^"]*)"/g, (m, val) => {
      try {
        const decoded = val.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        const list = JSON.parse(decoded);
        for (const item of list) {
          if (item.src) item.src = fix(item.src);
        }
        const encoded = JSON.stringify(list).replace(/"/g, '&quot;');
        return `data-ab-versions="${encoded}"`;
      } catch {
        return m;
      }
    })
    // 内联样式与样式表里的 `url(...)`。角色报告的缩略图就走这条
    // （`style="background-image:url('images/…')"`），只查属性会漏掉它，
    // 表现是缩略图 404 但大图正常——很不好排查，所以两条路都覆盖。
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, val) => `url(${q}${fix(val)}${q})`)
    .replace(/\bloading="lazy"/g, 'loading="eager"');
}

/* ------------------------------------------------------------------ */
/* 脚本加作用域                                                        */
/* ------------------------------------------------------------------ */

/**
 * 给一份报告的脚本套上作用域。
 *
 * 各报告的脚本都写成 `document.querySelector('.expo')` 这种全局查询——合成一页
 * 之后只会命中第一个面板的那个，其余四个导出按钮直接失效。这里用一个 Proxy 把
 * `document` 换掉：查询类方法限制在自己的 pane 内，`getElementById` 顺手补上
 * id 前缀（所以脚本里的 id 字符串一个都不用改），其余属性与方法原样透传给真的
 * document（`createElement` 这些还要用）。
 *
 * 整段包在 IIFE 里，顺带隔离各报告的顶层 `const`——五份脚本里有重名的。
 */
export function scopeJs(js, paneId, prefix) {
  return `(function(){
var __root=window.document.getElementById(${JSON.stringify(paneId)});
if(!__root)return;
var __doc=window.document;
var document=new Proxy(__doc,{get:function(t,k){
  if(k==='querySelector')return function(s){return __root.querySelector(s);};
  if(k==='querySelectorAll')return function(s){return __root.querySelectorAll(s);};
  if(k==='getElementById')return function(id){
    return __root.querySelector('#'+(window.CSS&&CSS.escape?CSS.escape(${JSON.stringify(prefix)}+id):${JSON.stringify(prefix)}+id));
  };
  var v=t[k];
  return typeof v==='function'?v.bind(t):v;
}});
try{
${js}
}catch(e){console.error(${JSON.stringify(paneId)},e);}
})();`;
}

/* ------------------------------------------------------------------ */
/* 组装一个面板                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把一份完整报告文档变成一个可以塞进外壳的面板。
 * 纯函数，不碰文件系统——自测直接喂 HTML 字符串就能验。
 */
export function makePane(html, { id, fromDir = '.', outDir = '.' } = {}) {
  const { style, body, scripts, title } = splitDoc(html);
  const paneId = `pane-${id}`;
  const prefix = `${id}--`;
  const scoped = rebaseAssets(scopeHtml(body, prefix), fromDir, outDir);
  return {
    id,
    paneId,
    title,
    css: rebaseAssets(scopeCss(style, `#${paneId}`), fromDir, outDir),
    html: scoped,
    js: scripts.filter((s) => s.trim()).map((s) => scopeJs(s, paneId, prefix)).join('\n'),
  };
}

/* ------------------------------------------------------------------ */
/* 外壳                                                                */
/* ------------------------------------------------------------------ */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SHELL_I18N = {
  zh: {
    kicker: '短剧制作报告',
    nav: '流水线',
    expandAll: '平铺全部',
    expandHint: '平铺之后 Cmd+F 能搜到所有面板',
    collapse: '回到分栏',
    empty: '没有任何一段的产出——至少要给一份 json',
    htmlLang: 'zh',
    reviewTitle: '资产变体对比与定稿',
    splitMode: '◫ 双图并排',
    sliderMode: '◧ 划卷滑块',
    singleMode: '▢ 单图检视',
    slotA: 'A 栏',
    slotB: 'B 栏',
    currentMaster: '⭐ 当前定稿',
    candidateVariant: '候选变体',
    makeMaster: '⭐ 设为定稿',
    copyCmd: '📋 复制定稿命令',
    copiedToast: '✓ 已复制定稿命令到剪贴板！',
    filmstripTitle: '历史候选版本胶卷（点击缩略图切换对比 / 设为 A·B 栏）',
    filmstripHint: '快捷键：←/→ 切换版本 · Esc 关闭 · 1/2/3 切换视图',
    diffPatch: '变体微调：',
    noPatch: '（基准初始版本）',
    modelLab: '模型：',
    gatesLab: '质检：',
    timeLab: '生成时间：',
    close: '关闭 (Esc)',
  },
  en: {
    kicker: 'Short-drama production report',
    nav: 'Pipeline',
    expandAll: 'Show all',
    expandHint: 'Showing all panes makes Cmd+F reach every section',
    collapse: 'Back to panes',
    empty: 'No stage produced anything — pass at least one json',
    htmlLang: 'en',
    reviewTitle: 'Asset Variant Comparison & Selection',
    splitMode: '◫ Side-by-Side',
    sliderMode: '◧ Split Slider',
    singleMode: '▢ Single View',
    slotA: 'Slot A',
    slotB: 'Slot B',
    currentMaster: '⭐ Current Master',
    candidateVariant: 'Candidate Variant',
    makeMaster: '⭐ Make Master',
    copyCmd: '📋 Copy Selection CLI',
    copiedToast: '✓ Copied selection CLI to clipboard!',
    filmstripTitle: 'Historical Candidates Filmstrip (Click to inspect or assign to Slot A / B)',
    filmstripHint: 'Shortcuts: ←/→ Cycle versions · Esc Close · 1/2/3 Switch mode',
    diffPatch: 'Variant Patch:',
    noPatch: '(Initial Baseline)',
    modelLab: 'Model:',
    gatesLab: 'Gates:',
    timeLab: 'Created:',
    close: 'Close (Esc)',
  },
};

/**
 * 外壳布局：左侧固定导航 + 右侧内容区。
 *
 * 只有当前面板显示，所以 Cmd+F 默认只搜得到当前这一份——这跟各报告「全部平铺
 * 可 Cmd+F」的设计主张是冲突的。所以留了「平铺全部」开关：按下之后所有面板同时
 * 显示，搜索恢复全局。默认分栏，因为五份加起来将近六十万字符，一次全渲染很沉。
 */
export function renderShell(panes, { title = '', lang = 'zh', subtitle = '' } = {}) {
  const t = SHELL_I18N[lang] ?? SHELL_I18N.zh;
  const nav = panes
    .map(
      (p, i) => `<button class="rp-nv${i === 0 ? ' rp-on' : ''}" data-pane="${esc(p.paneId)}" type="button">
  <span class="rp-nv-i">${String(i + 1)}</span>
  <span class="rp-nv-t"><b>${esc(lang === 'en' ? p.meta.labelEn : p.meta.label)}</b><small>${esc(lang === 'en' ? p.meta.hintEn : p.meta.hint)}</small></span>
</button>`,
    )
    .join('\n');

  const body = panes
    .map((p, i) => `<section class="rp-pane${i === 0 ? ' rp-on' : ''}" id="${esc(p.paneId)}">${p.html}</section>`)
    .join('\n');

  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(t.kicker)}</title>
<style>
/* ---- 外壳。视觉语言跟各报告同一套：冷灰印张 + 铁锈红印记 ---- */
:root{
  --paper:#f6f6f4; --panel:#fff; --ink:#1a1a18; --ink-2:#44443f; --ink-3:#77776f;
  --rule:#d2d5d0; --rule-2:#c2c6bf; --seal:#8a3324; --seal-soft:#8a332412;
  --rail:248px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--paper); color:var(--ink);
  font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.rp-app{display:flex;align-items:flex-start;min-height:100vh}

/* ---- 左侧导航 ---- */
.rp-rail{
  position:sticky;top:0;flex:0 0 var(--rail);width:var(--rail);height:100vh;
  background:var(--panel);border-right:1px solid var(--rule);
  display:flex;flex-direction:column;padding:22px 14px 16px;
}
.rp-brand{padding:0 8px 16px;border-bottom:1px solid var(--rule);margin-bottom:14px}
.rp-brand h1{margin:0;font-size:19px;font-weight:650;letter-spacing:.02em;line-height:1.3}
.rp-brand p{margin:5px 0 0;font-size:11.5px;color:var(--ink-3);letter-spacing:.06em}
.rp-brand .rp-sub{margin-top:8px;font-size:11.5px;color:var(--ink-2);line-height:1.5}
.rp-navlab{padding:0 8px 8px;font-size:10.5px;letter-spacing:.14em;color:var(--ink-3);text-transform:uppercase}
.rp-nv{
  display:flex;align-items:center;gap:10px;width:100%;padding:9px 8px;margin-bottom:2px;
  border:0;border-radius:7px;background:transparent;cursor:pointer;text-align:left;
  color:var(--ink-2);font:inherit;transition:background .12s,color .12s;
}
.rp-nv:hover{background:#0000000a}
.rp-nv .rp-nv-i{
  flex:0 0 22px;height:22px;border-radius:5px;border:1px solid var(--rule-2);
  display:grid;place-items:center;font-size:11px;color:var(--ink-3);background:var(--paper);
}
.rp-nv .rp-nv-t{display:flex;flex-direction:column;min-width:0}
.rp-nv .rp-nv-t b{font-weight:600;font-size:13.5px;color:var(--ink)}
.rp-nv .rp-nv-t small{font-size:11px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rp-nv.rp-on{background:var(--seal-soft)}
.rp-nv.rp-on .rp-nv-i{background:var(--seal);border-color:var(--seal);color:#fff}
.rp-nv.rp-on .rp-nv-t b{color:var(--seal)}
.rp-railfoot{margin-top:auto;padding:12px 8px 0;border-top:1px solid var(--rule)}
.rp-allbtn{
  width:100%;padding:7px 10px;border:1px solid var(--rule-2);border-radius:7px;
  background:var(--panel);color:var(--ink-2);font:inherit;font-size:12px;cursor:pointer;
}
.rp-allbtn:hover{border-color:var(--seal);color:var(--seal)}
.rp-allbtn:focus-visible{outline:2px solid var(--seal);outline-offset:2px}
.rp-railfoot p{margin:8px 2px 0;font-size:10.5px;color:var(--ink-3);line-height:1.5}

/* ---- 内容区 ---- */
.rp-main{flex:1 1 auto;min-width:0}
.rp-pane{display:none}
.rp-pane.rp-on{display:block}
.rp-app.rp-all .rp-pane{display:block;border-bottom:1px solid var(--rule)}
.rp-app.rp-all .rp-rail .rp-nv{opacity:.55}

/* 各报告原本自己撑满视口，塞进 pane 之后交给内容区控制宽度 */
.rp-pane{max-width:100%;overflow-x:auto}

@media (max-width:900px){
  .rp-app{display:block}
  .rp-rail{position:static;width:auto;height:auto;flex:none;border-right:0;border-bottom:1px solid var(--rule)}
  .rp-railfoot{margin-top:12px}
}
@media print{
  .rp-rail{display:none}
  .rp-pane{display:block!important;break-after:page}
}

/* ---- 变体评审工作台与 A/B 对比弹层 ---- */
.rp-ab-modal{
  position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;
  background:rgba(12,14,16,.86);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  padding:20px;
}
.rp-ab-modal.rp-on{display:flex}
.rp-ab-dialog{
  position:relative;width:1440px;max-width:98vw;height:94vh;background:var(--paper);
  border:1px solid var(--rule-2);border-radius:10px;display:flex;flex-direction:column;
  overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.45);
}
.rp-ab-head{
  display:flex;align-items:center;justify-content:space-between;padding:12px 18px;
  background:var(--panel);border-bottom:1px solid var(--rule);gap:14px;flex:none;
}
.rp-ab-titles{min-width:0;flex:1}
.rp-ab-titles h3{margin:0;font-size:16px;font-weight:650;color:var(--ink);letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rp-ab-titles p{margin:2px 0 0;font-size:11.5px;color:var(--ink-3);letter-spacing:.03em}
.rp-ab-modes{display:inline-flex;border:1px solid var(--rule-2);border-radius:6px;overflow:hidden;background:var(--paper)}
.rp-ab-mbtn{
  padding:6px 13px;font-size:12px;border:0;background:transparent;cursor:pointer;
  color:var(--ink-2);font-family:inherit;font-weight:500;transition:.12s;
}
.rp-ab-mbtn.rp-on{background:var(--ink);color:#fff}
.rp-ab-close{
  background:transparent;border:0;font-size:20px;line-height:1;cursor:pointer;
  padding:6px 10px;border-radius:5px;color:var(--ink-3);transition:.12s;
}
.rp-ab-close:hover{color:var(--seal);background:var(--seal-soft)}

/* ---- 对比舞台 ---- */
.rp-ab-stage{flex:1 1 auto;overflow:hidden;position:relative;background:#0f1114;display:flex}
.rp-ab-view{position:absolute;inset:0;display:none;width:100%;height:100%;padding:14px 16px;overflow:hidden}
.rp-ab-view.rp-on{display:flex}

/* 并排模式 */
.rp-ab-split.rp-on{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.rp-ab-col{
  display:flex;flex-direction:column;background:#15181c;border:1px solid #272c32;
  border-radius:8px;overflow:hidden;height:100%;min-height:0;
}
.rp-ab-col-head{
  display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1a1e23;
  border-bottom:1px solid #272c32;flex:none;
}
.rp-ab-badge-slot{font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;flex:none}
.rp-ab-badge-slot.slot-a{background:#234b34;color:#84e1a7}
.rp-ab-badge-slot.slot-b{background:#6e2e22;color:#ffab9d}
.rp-ab-select{
  padding:4px 8px;border-radius:4px;border:1px solid #3c444d;background:#23282f;
  color:#e4e7ea;font-size:12px;flex:1;min-width:0;outline:none;
}
.rp-ab-tag-master{font-size:11px;padding:2px 7px;border-radius:3px;font-weight:500;flex:none}
.rp-ab-tag-master.is-master{background:#ffd70022;color:#ffd700;border:1px solid #ffd70055}
.rp-ab-tag-master.not-master{background:#ffffff11;color:#8c939b}
.rp-ab-btn-master{
  padding:3px 9px;border-radius:4px;border:1px solid #e09320;background:#965a04;
  color:#fff;font-size:11px;cursor:pointer;flex:none;transition:.12s;
}
.rp-ab-btn-master:hover{background:#b86e05}
.rp-ab-btn-master[disabled]{opacity:.4;pointer-events:none}
.rp-ab-imgbox{
  flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;
  overflow:hidden;padding:12px;position:relative;background:#0d0f12;
}
.rp-ab-imgbox img{max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;box-shadow:0 6px 20px rgba(0,0,0,.6)}
.rp-ab-meta{
  flex:none;padding:10px 14px;background:#16191d;border-top:1px solid #272c32;
  font-size:11.5px;color:#a8adb3;
}
.rp-ab-patch{
  background:#2e2217;border:1px solid #7c4819;color:#ffc58a;padding:5px 9px;
  border-radius:4px;margin-bottom:6px;word-break:break-word;line-height:1.45;
}
.rp-ab-meta-grid{display:flex;flex-wrap:wrap;gap:6px 14px}
.rp-ab-meta-chip{color:#82888f}
.rp-ab-meta-chip b{color:#d8dde2;font-weight:500}

/* 划卷滑块模式 */
.rp-ab-slider.rp-on{display:flex;align-items:center;justify-content:center;padding:12px}
.rp-ab-slider-wrap{
  position:relative;width:100%;height:100%;max-width:1200px;background:#111417;
  border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;
  user-select:none;-webkit-user-select:none;touch-action:none;cursor:ew-resize;
}
.rp-ab-slider-layer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.rp-ab-slider-layer img{max-width:96%;max-height:96%;object-fit:contain;pointer-events:none;user-select:none}
.rp-ab-slider-top{clip-path:inset(0 0 0 calc(var(--pos, 50) * 1%))}
.rp-ab-slider-bar{
  position:absolute;top:0;bottom:0;left:calc(var(--pos, 50) * 1%);width:2px;
  background:#ffffff;z-index:10;transform:translateX(-50%);pointer-events:none;
  box-shadow:0 0 10px rgba(0,0,0,.8);
}
.rp-ab-slider-btn{
  position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:34px;height:34px;
  border-radius:50%;background:#ffffff;color:#181a1c;box-shadow:0 2px 10px rgba(0,0,0,.6);
  display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;
  letter-spacing:1px;
}
.rp-ab-tag-corner{
  position:absolute;top:14px;font-size:11px;padding:4px 10px;border-radius:4px;
  font-weight:600;z-index:15;pointer-events:none;
}
.rp-ab-tag-corner.tag-a{left:16px;background:rgba(35,75,52,.88);color:#84e1a7}
.rp-ab-tag-corner.tag-b{right:16px;background:rgba(110,46,34,.88);color:#ffab9d}

/* 单图模式 */
.rp-ab-single.rp-on{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px}
.rp-ab-single-wrap{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;width:100%}
.rp-ab-single-wrap img{max-width:96%;max-height:96%;object-fit:contain;border-radius:4px;box-shadow:0 6px 24px rgba(0,0,0,.6)}
.rp-ab-single-meta{flex:none;background:#15181c;border:1px solid #272c32;border-radius:6px;padding:8px 16px;font-size:12px;color:#a8adb3;max-width:900px;width:90%}

/* 胶卷缩略图条 */
.rp-ab-filmstrip{
  flex:none;height:124px;background:var(--panel);border-top:1px solid var(--rule);
  display:flex;flex-direction:column;padding:6px 16px 8px;gap:5px;
}
.rp-ab-film-head{display:flex;justify-content:space-between;align-items:baseline;font-size:11px;color:var(--ink-3)}
.rp-ab-film-head b{color:var(--ink);font-weight:600}
.rp-ab-track{display:flex;gap:10px;overflow-x:auto;flex:1 1 auto;min-height:0;padding-bottom:2px}
.rp-ab-card{
  flex:0 0 170px;border:1px solid var(--rule);border-radius:6px;background:var(--paper);
  display:flex;gap:8px;padding:5px;cursor:pointer;transition:.12s;position:relative;
  text-align:left;font:inherit;
}
.rp-ab-card:hover{border-color:var(--rule-2);background:#fff}
.rp-ab-card.is-a{border-color:#3d6b4f;background:#edf5ef;box-shadow:0 0 0 1px #3d6b4f}
.rp-ab-card.is-b{border-color:var(--seal);background:var(--seal-soft);box-shadow:0 0 0 1px var(--seal)}
.rp-ab-thumb{flex:0 0 52px;height:100%;border-radius:4px;background:#000;overflow:hidden}
.rp-ab-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.rp-ab-info{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:space-between}
.rp-ab-vhead{display:flex;align-items:center;gap:4px;white-space:nowrap}
.rp-ab-vhead b{font-size:12px;color:var(--ink)}
.rp-ab-star{color:#e09320;font-size:11px}
.rp-ab-chip-slot{font-size:9.5px;font-weight:700;padding:1px 4px;border-radius:2px;margin-left:auto}
.rp-ab-chip-slot.sa{background:#234b34;color:#84e1a7}
.rp-ab-chip-slot.sb{background:#6e2e22;color:#ffab9d}
.rp-ab-vpatch{
  font-size:10px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.3;
}
.rp-ab-vmodel{font-size:9.5px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* 定稿命令底栏 */
.rp-ab-foot{
  display:flex;align-items:center;justify-content:space-between;padding:9px 18px;
  background:var(--paper);border-top:1px solid var(--rule);gap:12px;flex:none;
}
.rp-ab-cmdbox{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0}
.rp-ab-cmdlab{font-size:11.5px;color:var(--ink-3);flex:none;white-space:nowrap}
.rp-ab-cmdbox code{
  font-size:11px;font-family:ui-monospace,Menlo,monospace;background:var(--panel);
  border:1px solid var(--rule);border-radius:4px;padding:5px 8px;flex:1 1 auto;
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);
}
.rp-ab-copycmd{
  padding:6px 14px;font-size:12px;font-weight:500;font-family:inherit;
  background:var(--seal);color:#fff;border:0;border-radius:5px;cursor:pointer;
  transition:.12s;flex:none;white-space:nowrap;
}
.rp-ab-copycmd:hover{background:#a33e2c}
.rp-ab-toast{display:none;font-size:11.5px;color:var(--ok);font-weight:600;flex:none}
.rp-ab-toast.rp-on{display:inline-block}

/* 小药丸微调角标 */
.rp-ab-open{cursor:pointer}
.rp-ab-pill{
  display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;
  padding:1px 6px;border-radius:99px;border:1px solid var(--rule-2);background:var(--panel);
  color:var(--ink-2);cursor:pointer;transition:.12s;margin-left:4px;
}
.rp-ab-pill:hover{border-color:var(--seal);color:var(--seal)}

/* ---- 各面板自己的样式，已加作用域前缀 ---- */
${panes.map((p) => `/* ===== ${p.id} ===== */\n${p.css}`).join('\n')}
</style>
</head>
<body>
<div class="rp-app" id="rp-app">
  <nav class="rp-rail">
    <div class="rp-brand">
      <h1>${esc(title)}</h1>
      <p>${esc(t.kicker)}</p>
      ${subtitle ? `<div class="rp-sub">${esc(subtitle)}</div>` : ''}
    </div>
    <div class="rp-navlab">${esc(t.nav)}</div>
    ${nav}
    <div class="rp-railfoot">
      <button class="rp-allbtn" id="rp-allbtn" type="button">${esc(t.expandAll)}</button>
      <p>${esc(t.expandHint)}</p>
    </div>
  </nav>
  <main class="rp-main">
${body}
  </main>
</div>
<div class="rp-ab-modal" id="rp-ab-modal" role="dialog" aria-modal="true" aria-hidden="true">
  <div class="rp-ab-dialog">
    <header class="rp-ab-head">
      <div class="rp-ab-titles">
        <h3 id="rp-ab-title">${esc(t.reviewTitle)}</h3>
        <p id="rp-ab-sub"></p>
      </div>
      <div class="rp-ab-modes" role="tablist">
        <button class="rp-ab-mbtn rp-on" data-mode="split" type="button">${esc(t.splitMode)}</button>
        <button class="rp-ab-mbtn" data-mode="slider" type="button">${esc(t.sliderMode)}</button>
        <button class="rp-ab-mbtn" data-mode="single" type="button">${esc(t.singleMode)}</button>
      </div>
      <button class="rp-ab-close" id="rp-ab-close" type="button" aria-label="${esc(t.close)}">✕</button>
    </header>

    <div class="rp-ab-stage">
      <!-- 并排对比 -->
      <div class="rp-ab-view rp-ab-split rp-on" id="rp-ab-view-split">
        <div class="rp-ab-col" id="rp-ab-col-a">
          <div class="rp-ab-col-head">
            <span class="rp-ab-badge-slot slot-a">${esc(t.slotA)}</span>
            <select class="rp-ab-select" id="rp-ab-select-a" aria-label="${esc(t.slotA)}"></select>
            <span class="rp-ab-tag-master" id="rp-ab-tag-a"></span>
            <button class="rp-ab-btn-master" id="rp-ab-btn-a" type="button">${esc(t.makeMaster)}</button>
          </div>
          <div class="rp-ab-imgbox">
            <img id="rp-ab-img-a" src="" alt="${esc(t.slotA)}">
          </div>
          <div class="rp-ab-meta" id="rp-ab-meta-a"></div>
        </div>

        <div class="rp-ab-col" id="rp-ab-col-b">
          <div class="rp-ab-col-head">
            <span class="rp-ab-badge-slot slot-b">${esc(t.slotB)}</span>
            <select class="rp-ab-select" id="rp-ab-select-b" aria-label="${esc(t.slotB)}"></select>
            <span class="rp-ab-tag-master" id="rp-ab-tag-b"></span>
            <button class="rp-ab-btn-master" id="rp-ab-btn-b" type="button">${esc(t.makeMaster)}</button>
          </div>
          <div class="rp-ab-imgbox">
            <img id="rp-ab-img-b" src="" alt="${esc(t.slotB)}">
          </div>
          <div class="rp-ab-meta" id="rp-ab-meta-b"></div>
        </div>
      </div>

      <!-- 划卷滑块对比 -->
      <div class="rp-ab-view rp-ab-slider" id="rp-ab-view-slider">
        <div class="rp-ab-slider-wrap" id="rp-ab-slider-wrap" style="--pos:50">
          <div class="rp-ab-slider-layer rp-ab-slider-bottom">
            <img id="rp-ab-simg-a" src="" alt="${esc(t.slotA)}">
            <span class="rp-ab-tag-corner tag-a" id="rp-ab-stag-a">A: v1</span>
          </div>
          <div class="rp-ab-slider-layer rp-ab-slider-top">
            <img id="rp-ab-simg-b" src="" alt="${esc(t.slotB)}">
            <span class="rp-ab-tag-corner tag-b" id="rp-ab-stag-b">B: v2</span>
          </div>
          <div class="rp-ab-slider-bar">
            <div class="rp-ab-slider-btn">◂ ▸</div>
          </div>
        </div>
      </div>

      <!-- 单图检视 -->
      <div class="rp-ab-view rp-ab-single" id="rp-ab-view-single">
        <div class="rp-ab-single-wrap">
          <img id="rp-ab-single-img" src="" alt="${esc(t.singleMode)}">
        </div>
        <div class="rp-ab-single-meta" id="rp-ab-single-meta"></div>
      </div>
    </div>

    <!-- 底部胶卷 -->
    <div class="rp-ab-filmstrip">
      <div class="rp-ab-film-head">
        <span><b>${esc(t.filmstripTitle)}</b></span>
        <span>${esc(t.filmstripHint)}</span>
      </div>
      <div class="rp-ab-track" id="rp-ab-track"></div>
    </div>

    <!-- 底部定稿命令 -->
    <footer class="rp-ab-foot">
      <div class="rp-ab-cmdbox">
        <span class="rp-ab-cmdlab">${esc(lang === 'en' ? 'Lock Selection CLI:' : '终端定稿命令：')}</span>
        <code id="rp-ab-cmd">node ...</code>
      </div>
      <button class="rp-ab-copycmd" id="rp-ab-copycmd" type="button">${esc(t.copyCmd)}</button>
      <span class="rp-ab-toast" id="rp-ab-toast">${esc(t.copiedToast)}</span>
    </footer>
  </div>
</div>
<script>
(function(){
  var app=document.getElementById('rp-app');
  var navs=[].slice.call(document.querySelectorAll('.rp-rail .rp-nv'));
  var panes=[].slice.call(document.querySelectorAll('.rp-main .rp-pane'));
  function show(id){
    navs.forEach(function(n){n.classList.toggle('rp-on',n.dataset.pane===id);});
    panes.forEach(function(p){p.classList.toggle('rp-on',p.id===id);});
    if(history.replaceState)history.replaceState(null,'','#'+id);
    window.scrollTo(0,0);
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('scroll'));
  }
  navs.forEach(function(n){n.addEventListener('click',function(){app.classList.remove('rp-all');show(n.dataset.pane);});});
  // 数字键 1–9 直接切面板
  document.addEventListener('keydown',function(e){
    if(e.metaKey||e.ctrlKey||e.altKey)return;
    var tag=(e.target&&e.target.tagName||'').toLowerCase();
    if(tag==='input'||tag==='textarea'||tag==='select')return;
    var abM=document.getElementById('rp-ab-modal');
    if(abM&&abM.classList.contains('rp-on'))return;
    var i=parseInt(e.key,10);
    if(i>=1&&i<=navs.length){app.classList.remove('rp-all');show(navs[i-1].dataset.pane);}
  });
  // 平铺：所有面板同时显示，Cmd+F 恢复全局
  var all=document.getElementById('rp-allbtn');
  var LBL={on:${JSON.stringify(t.collapse)},off:${JSON.stringify(t.expandAll)}};
  all.addEventListener('click',function(){
    var on=app.classList.toggle('rp-all');
    all.textContent=on?LBL.on:LBL.off;
  });
  // 深链：#pane-script 直接落到那一屏
  var h=(location.hash||'').replace(/^#/,'');
  if(h&&document.getElementById(h))show(h);

  // ================================================================
  // 变体评审工作台 / A/B 对比交互脚本
  // ================================================================
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var abModal = document.getElementById('rp-ab-modal');
  var abTitle = document.getElementById('rp-ab-title');
  var abSub = document.getElementById('rp-ab-sub');
  var abClose = document.getElementById('rp-ab-close');
  var abModes = [].slice.call(document.querySelectorAll('.rp-ab-mbtn'));
  var abViews = {
    split: document.getElementById('rp-ab-view-split'),
    slider: document.getElementById('rp-ab-view-slider'),
    single: document.getElementById('rp-ab-view-single'),
  };
  var abSelectA = document.getElementById('rp-ab-select-a');
  var abSelectB = document.getElementById('rp-ab-select-b');
  var abTagA = document.getElementById('rp-ab-tag-a');
  var abTagB = document.getElementById('rp-ab-tag-b');
  var abBtnA = document.getElementById('rp-ab-btn-a');
  var abBtnB = document.getElementById('rp-ab-btn-b');
  var abImgA = document.getElementById('rp-ab-img-a');
  var abImgB = document.getElementById('rp-ab-img-b');
  var abMetaA = document.getElementById('rp-ab-meta-a');
  var abMetaB = document.getElementById('rp-ab-meta-b');
  var abSImgA = document.getElementById('rp-ab-simg-a');
  var abSImgB = document.getElementById('rp-ab-simg-b');
  var abSTagA = document.getElementById('rp-ab-stag-a');
  var abSTagB = document.getElementById('rp-ab-stag-b');
  var abSingleImg = document.getElementById('rp-ab-single-img');
  var abSingleMeta = document.getElementById('rp-ab-single-meta');
  var abTrack = document.getElementById('rp-ab-track');
  var abCmd = document.getElementById('rp-ab-cmd');
  var abCopyCmd = document.getElementById('rp-ab-copycmd');
  var abToast = document.getElementById('rp-ab-toast');
  var sliderWrap = document.getElementById('rp-ab-slider-wrap');

  var ctx = null;

  function getCmd(v) {
    if (!ctx) return '';
    if (ctx.assetType === 'art') {
      return 'node .agents/shuohao-skills/skills/novel-art/scripts/novel-art.mjs select ' +
        (ctx.assetPath || 'art.json') + ' ' + (ctx.itemId || '') + ' ' + v;
    }
    return 'node .agents/shuohao-skills/skills/character-refs/scripts/character-refs.mjs select ' +
      (ctx.assetPath || 'asset.json') + ' ' + ctx.view + ' ' + v +
      (ctx.outfit && ctx.outfit !== 'default' ? ' --outfit ' + ctx.outfit : '');
  }

  function renderMetaHtml(ver) {
    if (!ver) return '<div class="rp-ab-meta-grid">暂无信息</div>';
    var patchHtml = ver.patch
      ? '<div class="rp-ab-patch"><b>' + ${JSON.stringify(t.diffPatch)} + '</b>' + esc(ver.patch) + '</div>'
      : '<div class="rp-ab-patch" style="background:#1c2024;border-color:#323840;color:#9aa0a6;"><b>' + ${JSON.stringify(t.diffPatch)} + '</b>' + ${JSON.stringify(t.noPatch)} + '</div>';
    var chips = [];
    if (ver.model) chips.push('<span class="rp-ab-meta-chip">' + ${JSON.stringify(t.modelLab)} + '<b>' + esc(ver.model) + '</b></span>');
    if (ver.seed !== null && ver.seed !== undefined && ver.seed !== '') chips.push('<span class="rp-ab-meta-chip">Seed: <b>' + esc(ver.seed) + '</b></span>');
    if (ver.gatesText) chips.push('<span class="rp-ab-meta-chip">' + ${JSON.stringify(t.gatesLab)} + '<b>' + esc(ver.gatesText) + '</b></span>');
    if (ver.createdAt) chips.push('<span class="rp-ab-meta-chip">' + ${JSON.stringify(t.timeLab)} + '<b>' + esc(String(ver.createdAt).replace('T', ' ').slice(0, 16)) + '</b></span>');
    return patchHtml + '<div class="rp-ab-meta-grid">' + chips.join('') + '</div>';
  }

  function populateSelect(selectEl, selectedVal) {
    selectEl.innerHTML = '';
    ctx.versions.forEach(function(ver) {
      var opt = document.createElement('option');
      opt.value = String(ver.v);
      opt.textContent = 'v' + ver.v + (ver.v === ctx.currentMasterV ? ' (⭐ 定稿)' : '') + (ver.patch ? ' · ' + ver.patch.slice(0, 24) : '');
      if (ver.v === selectedVal) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }

  function syncUI() {
    if (!ctx) return;
    abTitle.textContent = ctx.title;
    abSub.textContent = (ctx.versions.length > 1
      ? '共 ' + ctx.versions.length + ' 个历史候选版本 · 当前定稿：v' + ctx.currentMasterV
      : '单版本资产 · 当前定稿：v' + ctx.currentMasterV);

    abModes.forEach(function(b) { b.classList.toggle('rp-on', b.dataset.mode === ctx.mode); });
    Object.keys(abViews).forEach(function(k) { abViews[k].classList.toggle('rp-on', k === ctx.mode); });

    var verA = ctx.versions.find(function(x) { return x.v === ctx.slotA; }) || ctx.versions[0];
    var verB = ctx.versions.find(function(x) { return x.v === ctx.slotB; }) || ctx.versions[Math.min(1, ctx.versions.length - 1)];

    populateSelect(abSelectA, verA.v);
    populateSelect(abSelectB, verB.v);

    var isMasterA = verA.v === ctx.currentMasterV;
    var isMasterB = verB.v === ctx.currentMasterV;

    abTagA.textContent = isMasterA ? ${JSON.stringify(t.currentMaster)} : ${JSON.stringify(t.candidateVariant)};
    abTagA.className = 'rp-ab-tag-master ' + (isMasterA ? 'is-master' : 'not-master');
    abBtnA.disabled = isMasterA;

    abTagB.textContent = isMasterB ? ${JSON.stringify(t.currentMaster)} : ${JSON.stringify(t.candidateVariant)};
    abTagB.className = 'rp-ab-tag-master ' + (isMasterB ? 'is-master' : 'not-master');
    abBtnB.disabled = isMasterB;

    abImgA.src = verA.src || '';
    abImgB.src = verB.src || '';
    abMetaA.innerHTML = renderMetaHtml(verA);
    abMetaB.innerHTML = renderMetaHtml(verB);

    abSImgA.src = verA.src || '';
    abSImgB.src = verB.src || '';
    abSTagA.textContent = 'A: v' + verA.v + (isMasterA ? ' (⭐)' : '');
    abSTagB.textContent = 'B: v' + verB.v + (isMasterB ? ' (⭐)' : '');

    var singleVer = ctx.mode === 'single' ? verB : verA;
    abSingleImg.src = singleVer.src || '';
    abSingleMeta.innerHTML = renderMetaHtml(singleVer);

    // 渲染底部胶卷
    abTrack.innerHTML = '';
    ctx.versions.forEach(function(ver) {
      var card = document.createElement('div');
      var isA = ver.v === verA.v;
      var isB = ver.v === verB.v;
      var isM = ver.v === ctx.currentMasterV;
      card.className = 'rp-ab-card' + (isA ? ' is-a' : '') + (isB ? ' is-b' : '');
      var chipSlot = isA ? '<span class="rp-ab-chip-slot sa">A 栏</span>'
        : isB ? '<span class="rp-ab-chip-slot sb">B 栏</span>' : '';
      var star = isM ? '<span class="rp-ab-star" title="当前定稿">⭐</span>' : '';
      card.innerHTML = '<div class="rp-ab-thumb"><img src="' + esc(ver.src) + '" alt="v' + ver.v + '"></div>' +
        '<div class="rp-ab-info">' +
          '<div class="rp-ab-vhead"><b>v' + ver.v + '</b>' + star + chipSlot + '</div>' +
          '<div class="rp-ab-vpatch">' + esc(ver.patch || '基准初始版本') + '</div>' +
          '<div class="rp-ab-vmodel">' + esc(ver.model || '') + '</div>' +
        '</div>';
      card.addEventListener('click', function() {
        if (ctx.mode === 'split') {
          if (ver.v !== ctx.slotA) ctx.slotB = ver.v;
          else if (ctx.versions.length > 1) {
            ctx.slotA = ctx.slotB;
            ctx.slotB = ver.v;
          }
        } else {
          ctx.slotB = ver.v;
          ctx.slotA = ver.v;
        }
        syncUI();
      });
      abTrack.appendChild(card);
    });

    var activeV = (ctx.slotB !== ctx.currentMasterV ? ctx.slotB : ctx.slotA);
    abCmd.textContent = getCmd(activeV);
  }

  function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).catch(function(){});
    }
    abToast.classList.add('rp-on');
    setTimeout(function() { abToast.classList.remove('rp-on'); }, 2200);
  }

  abCopyCmd.addEventListener('click', function() {
    copyText(abCmd.textContent);
  });

  abBtnA.addEventListener('click', function() {
    if (!ctx) return;
    ctx.currentMasterV = ctx.slotA;
    copyText(getCmd(ctx.slotA));
    syncUI();
  });

  abBtnB.addEventListener('click', function() {
    if (!ctx) return;
    ctx.currentMasterV = ctx.slotB;
    copyText(getCmd(ctx.slotB));
    syncUI();
  });

  abSelectA.addEventListener('change', function() {
    if (!ctx) return;
    ctx.slotA = parseInt(abSelectA.value, 10);
    syncUI();
  });

  abSelectB.addEventListener('change', function() {
    if (!ctx) return;
    ctx.slotB = parseInt(abSelectB.value, 10);
    syncUI();
  });

  abModes.forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (!ctx) return;
      ctx.mode = btn.dataset.mode;
      syncUI();
    });
  });

  // 划卷滑块拖动
  var isSliderDragging = false;
  function updateSliderPos(clientX) {
    if (!sliderWrap) return;
    var rect = sliderWrap.getBoundingClientRect();
    var x = clientX - rect.left;
    var pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    sliderWrap.style.setProperty('--pos', pct);
  }
  if (sliderWrap) {
    sliderWrap.addEventListener('mousedown', function(e) { isSliderDragging = true; updateSliderPos(e.clientX); });
    window.addEventListener('mousemove', function(e) { if (isSliderDragging) updateSliderPos(e.clientX); });
    window.addEventListener('mouseup', function() { isSliderDragging = false; });
    sliderWrap.addEventListener('touchstart', function(e) { if (e.touches[0]) { isSliderDragging = true; updateSliderPos(e.touches[0].clientX); } }, { passive: true });
    window.addEventListener('touchmove', function(e) { if (isSliderDragging && e.touches[0]) updateSliderPos(e.touches[0].clientX); }, { passive: true });
    window.addEventListener('touchend', function() { isSliderDragging = false; });
  }

  // 键盘快捷键
  document.addEventListener('keydown', function(e) {
    if (!abModal || !abModal.classList.contains('rp-on')) return;
    if (e.key === 'Escape') {
      abModal.classList.remove('rp-on');
      abModal.setAttribute('aria-hidden', 'true');
    } else if (e.key === '1') {
      ctx.mode = 'split';
      syncUI();
    } else if (e.key === '2') {
      ctx.mode = 'slider';
      syncUI();
    } else if (e.key === '3') {
      ctx.mode = 'single';
      syncUI();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (!ctx || !ctx.versions || !ctx.versions.length) return;
      var idx = ctx.versions.findIndex(function(v) { return v.v === ctx.slotB; });
      if (idx >= 0) {
        var nextIdx = e.key === 'ArrowRight'
          ? (idx + 1) % ctx.versions.length
          : (idx - 1 + ctx.versions.length) % ctx.versions.length;
        ctx.slotB = ctx.versions[nextIdx].v;
        syncUI();
      }
    }
  });

  abClose.addEventListener('click', function() {
    abModal.classList.remove('rp-on');
    abModal.setAttribute('aria-hidden', 'true');
  });
  abModal.addEventListener('click', function(e) {
    if (e.target === abModal) {
      abModal.classList.remove('rp-on');
      abModal.setAttribute('aria-hidden', 'true');
    }
  });

  // 全局捕获相册与对比点击
  document.addEventListener('click', function(e) {
    if (e.target.closest('#rp-ab-modal')) return;
    var trigger = e.target.closest('[data-ab-versions]');
    if (!trigger) {
      var container = e.target.closest('.rp-ab-open, .rp-ab-pill, .bust, .cell, .full, figure.plate, .plate, button.zoom');
      if (container) {
        trigger = container.dataset.abVersions ? container : (container.querySelector('[data-ab-versions]') || (container.parentElement ? container.parentElement.querySelector('[data-ab-versions]') : null));
      }
    }
    if (trigger && trigger.dataset.abVersions) {
      try {
        var raw = trigger.dataset.abVersions;
        var vers = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(vers) && (vers.length > 1 || trigger.classList.contains('rp-ab-open') || trigger.classList.contains('rp-ab-pill'))) {
          e.preventDefault();
          e.stopPropagation();
          vers.sort(function(a, b) { return a.v - b.v; });
          var curMaster = parseInt(trigger.dataset.abCurrent || '1', 10);
          var slotA = vers[0].v;
          var slotB = vers.length > 1
            ? (curMaster !== vers[0].v ? curMaster : vers[1].v)
            : vers[0].v;
          ctx = {
            title: trigger.dataset.abTitle || '资产对比',
            assetType: trigger.dataset.abType || 'refs',
            assetPath: trigger.dataset.abAsset || '',
            view: trigger.dataset.abView || '',
            outfit: trigger.dataset.abOutfit || 'default',
            itemId: trigger.dataset.abItemId || '',
            currentMasterV: curMaster,
            versions: vers,
            slotA: slotA,
            slotB: slotB,
            mode: vers.length > 1 ? 'split' : 'single',
          };
          syncUI();
          abModal.classList.add('rp-on');
          abModal.setAttribute('aria-hidden', 'false');
          return;
        }
      } catch (err) {
        console.error('打开变体评审失败', err);
      }
    }
  }, true);
})();
</script>
${panes.map((p) => (p.js ? `<script>\n${p.js}\n</script>` : '')).filter(Boolean).join('\n')}
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const USAGE = `report.mjs —— 把影视短剧各 skill 的报告合成一张单页

  node scripts/report.mjs --from <demo目录> [--out report.html] [--lang zh|en]
  node scripts/report.mjs --outline o.json --cast c.json … [--out report.html]

  --from <目录>      按端到端 demo 工作目录约定自动发现：
                     outline/ characters/ refs/ art/ script/ staging/ storyboard/ 各取一份 json
  --outline <f>      单独指定某一段的 json，可与 --from 混用（显式的优先）
  --cast <f>
  --refs <f...>      角色定妆资产 asset.json，或存有各角色 asset.json 的目录
  --art <f>
  --script <f>
  --staging <f>
  --storyboard <f>
  --out <f>          输出路径，默认 report.html
  --lang zh|en       外壳与各报告的界面语言，默认 zh
  --title <s>        左上角标题，默认取第一份 json 的 source

  **给了哪几段就出哪几个面板**——只有角色就只有一个面板，七段齐全就是七个。
  各 skill 的 render 一行不改，仍然可以单独出各自的报告。`;

function flag(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

/** 在一个目录里找该段产出的 json（排掉报告与清单类文件）。 */
function findJson(dir, skill) {
  if (!existsSync(dir)) return null;
  if (skill === 'character-refs') {
    const assets = [];
    if (existsSync(join(dir, 'asset.json'))) assets.push(join(dir, 'asset.json'));
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subAsset = join(dir, entry.name, 'asset.json');
        if (existsSync(subAsset)) assets.push(subAsset);
      } else if (entry.name.endsWith('-asset.json') || entry.name === 'asset.json') {
        const full = join(dir, entry.name);
        if (!assets.includes(full)) assets.push(full);
      }
    }
    return assets.length ? assets : null;
  }
  const kind = skill.replace('novel-', '');
  const stem = kind === 'characters' ? 'cast' : kind;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !/manifest|\.gates/i.test(f))
    .filter((f) => f.toLowerCase().includes(stem));
  return files.length ? join(dir, files[0]) : null;
}

function main(argv) {
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const from = flag(argv, '--from');
  const outPath = resolve(flag(argv, '--out', 'report.html'));
  const outDir = dirname(outPath);
  const lang = flag(argv, '--lang', 'zh');

  // 路径来源：显式参数优先，其次从 --from 目录自动发现
  const paths = {};
  for (const p of PANES) {
    const explicit = flag(argv, p.flag);
    paths[p.flag] = explicit ? resolve(explicit) : from ? findJson(resolve(from, p.dir), p.skill) : null;
  }

  const chosen = PANES.filter((p) => paths[p.flag]);
  if (!chosen.length) throw new Error(`没有找到任何一段的产出。\n\n${USAGE}`);

  const panes = [];
  for (const p of chosen) {
    const jsonPath = paths[p.flag];
    const cli = join(skillsDir, p.skill, 'scripts', `${p.skill}.mjs`);
    let args;
    let fromDir;
    let cwd;
    if (p.skill === 'character-refs') {
      const assetFiles = Array.isArray(jsonPath) ? jsonPath : [jsonPath];
      args = ['render', ...assetFiles, '--lang', lang];
      fromDir = from ? resolve(from, p.dir) : dirname(assetFiles[0]);
      cwd = fromDir;
    } else {
      args = ['render', jsonPath, '--html', '--lang', lang];
      fromDir = dirname(jsonPath);
      cwd = dirname(jsonPath);
    }
    for (const need of p.needs) {
      // 上游有就带上；没有就不带，各 skill 自己会说明跳过了什么
      if (paths[need] && typeof paths[need] === 'string') args.push(need, paths[need]);
    }
    let html;
    try {
      // cwd 定在 json 所在目录：各 skill 的图存在检查是相对那里做的
      html = execFileSync(process.execPath, [cli, ...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '' },
      });
    } catch (e) {
      const why = (e.stderr || e.message || '').trim().split('\n')[0];
      console.error(`⚠️ ${p.skill} 这一段没渲染出来，跳过：${why}`);
      continue;
    }
    const pane = makePane(html, { id: p.id, fromDir, outDir });
    pane.meta = p;
    panes.push(pane);
  }

  if (!panes.length) throw new Error('每一段都没渲染成功，没有可合成的内容');

  const titleFlag = flag(argv, '--title');
  let title = titleFlag;
  if (!title) {
    const rawFirst = paths[chosen[0].flag];
    const first = Array.isArray(rawFirst) ? rawFirst[0] : rawFirst;
    try {
      title = JSON.parse(readFileSync(first, 'utf8')).source ?? '';
    } catch { /* 读不出来就退回文件名 */ }
    if (!title) title = basename(first).replace(/[-_](cast|outline|art|script|storyboard|staging|asset)\.json$/i, '').replace(/\.json$/i, '');
  }

  const sub = panes.map((p) => (lang === 'en' ? p.meta.labelEn : p.meta.label)).join(lang === 'en' ? ' · ' : ' · ');
  writeFileSync(outPath, renderShell(panes, { title, lang, subtitle: sub }));
  console.log(`✓ ${panes.length} 个面板 → ${relative(process.cwd(), outPath) || outPath}`);
  for (const p of panes) console.log(`    ${lang === 'en' ? p.meta.labelEn : p.meta.label}  ${p.title || ''}`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
