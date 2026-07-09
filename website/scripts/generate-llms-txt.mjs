import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const docsRoot = join(root, 'src/content/docs');
const distRoot = join(root, 'dist');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.name.endsWith('.md')) {
      yield path;
    }
  }
}

const docs = [];
for await (const path of walk(docsRoot)) {
  const source = await readFile(path, 'utf8');
  const title = source.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? relative(docsRoot, path);
  docs.push({ path, title, source });
}

docs.sort((left, right) => left.path.localeCompare(right.path));

const docRoute = (path) => {
  const slug = relative(docsRoot, path).replace(/\.md$/u, '');
  return `/${slug}/`;
};

await mkdir(distRoot, { recursive: true });
await writeFile(
  join(distRoot, 'llms.txt'),
  [
    '# Simfile',
    '',
    'Simfile declares deterministic simulation worlds for agentic organizations.',
    '',
    ...docs.map((doc) => `- ${doc.title}: ${docRoute(doc.path)}`),
    '',
  ].join('\n'),
);

await writeFile(
  join(distRoot, 'llms-full.txt'),
  [
    '# Simfile Documentation',
    '',
    ...docs.flatMap((doc) => [`## ${doc.title}`, '', doc.source, '']),
  ].join('\n'),
);
