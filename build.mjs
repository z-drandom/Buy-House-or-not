/* 装配自包含单文件：node build.mjs → index.html */
import { readFileSync, writeFileSync } from 'node:fs';

const template = readFileSync('src/index.template.html', 'utf8');
const style = readFileSync('src/style.css', 'utf8');
const echartsLib = readFileSync('vendor/echarts.min.js', 'utf8');
const calcJs = readFileSync('src/calc.js', 'utf8');
const appJs = readFileSync('src/app.js', 'utf8');

for (const [name, content] of [['STYLE', style], ['ECHARTS', echartsLib], ['CALC', calcJs], ['APP', appJs]]) {
  if (content.includes('</script>')) throw new Error(`${name} 内容包含 </script>，会破坏内联`);
}

const html = template
  .split('/*__STYLE__*/').join(style)
  .split('/*__ECHARTS__*/').join(echartsLib)
  .split('/*__CALC__*/').join(calcJs)
  .split('/*__APP__*/').join(appJs);

writeFileSync('index.html', html);
console.log(`index.html 已生成（${(html.length / 1024 / 1024).toFixed(2)} MB）`);
