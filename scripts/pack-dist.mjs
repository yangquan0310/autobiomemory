#!/usr/bin/env node
/**
 * Package the built plugin for installation from `dist/`.
 *
 *   node scripts/pack-dist.mjs
 *
 * Produces:
 *   dist/package/                              an installable package directory
 *   dist/deepseek-harness-autobiomemory-<v>.tgz  the same package as a tarball
 *
 * The docker/no-network install path is:
 *   dsh plugin --profile web add "file:<repo>/dist/deepseek-harness-autobiomemory-0.1.0.tgz"
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const distDir = path.join(repo, 'dist')
const pkgDir = path.join(distDir, 'package')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function copyInto(target, source) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true })
}

const rootPkg = readJson(path.join(repo, 'package.json'))

if (!fs.existsSync(path.join(repo, 'dist', 'index.js'))) {
  console.error('dist/index.js is missing — run `pnpm run build` first')
  process.exit(1)
}

fs.mkdirSync(pkgDir, { recursive: true })
for (const entry of ['index.js', 'index.d.ts', 'cli.js', 'cli.d.ts']) {
  const file = path.join(distDir, entry)
  if (fs.existsSync(file)) copyInto(path.join(pkgDir, entry), file)
}
for (const entry of ['index.js.map', 'cli.js.map']) {
  const file = path.join(distDir, entry)
  if (fs.existsSync(file)) copyInto(path.join(pkgDir, entry), file)
}
for (const entry of ['cordis.patch.yml', 'README.md', 'AGENTS.md', 'LICENSE']) {
  const file = path.join(repo, entry)
  if (fs.existsSync(file)) copyInto(path.join(pkgDir, entry), file)
}
if (fs.existsSync(path.join(repo, 'docs'))) {
  copyInto(path.join(pkgDir, 'docs'), path.join(repo, 'docs'))
}

const pkgJson = {
  name: rootPkg.name,
  version: rootPkg.version,
  description: rootPkg.description,
  type: 'module',
  main: 'index.js',
  types: 'index.d.ts',
  exports: {
    '.': { types: './index.d.ts', default: './index.js' },
    './cli': { types: './cli.d.ts', default: './cli.js' },
  },
  bin: { autobiomemory: './cli.js' },
  files: ['index.js', 'index.d.ts', 'cli.js', 'cli.d.ts', 'cordis.patch.yml', 'docs', 'README.md', 'AGENTS.md'],
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  dependencies: { '@deepseek-ai/schemastery': rootPkg.dependencies['@deepseek-ai/schemastery'] },
  peerDependencies: rootPkg.peerDependencies,
  license: rootPkg.license,
  engines: rootPkg.engines,
}
fs.writeFileSync(path.join(pkgDir, 'package.json'), `${JSON.stringify(pkgJson, null, 2)}\n`)

// tarball via pnpm pack so `file:` installs behave exactly like a registry install
let tarball
try {
  const out = execFileSync('pnpm', ['pack', '--pack-destination', distDir], {
    cwd: pkgDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const last = out.trim().split('\n').pop() ?? ''
  tarball = path.isAbsolute(last) ? last : path.join(distDir, last)
} catch (error) {
  console.warn(`pnpm pack failed (${error.message}); the dist/package directory is still installable`)
}

fs.writeFileSync(
  path.join(distDir, 'INSTALL.md'),
  [
    '# AutoBioMemory — install from dist',
    '',
    '```bash',
    `dsh plugin --profile web add "file:${tarball ?? pkgDir}"`,
    '```',
    '',
    'Then restart the profile process so the bundle layer loads, and verify with:',
    '',
    '```bash',
    'dsh --profile web --dump-config | grep -A6 autobiomemory',
    'autobiomemory doctor',
    '```',
    '',
  ].join('\n'),
)

console.log(`dist/package ready: ${pkgDir}`)
if (tarball) console.log(`tarball: ${tarball}`)
