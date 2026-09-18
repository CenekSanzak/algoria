import { copyFile, mkdir } from 'node:fs/promises';

await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
for (const file of ['index.html', 'styles.css', 'script.js']) {
  await copyFile(new URL(file, import.meta.url), new URL(`./dist/${file}`, import.meta.url));
}
console.log('Built the static landing page in dist/.');
