import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { SOUND_IDS } from './audio-core.js';

export const PIPELINE = 'vocal2midi-ustx-v1';
const PROJECT_ID = /^v2m-[a-z0-9-]+$/;

export function workspaceFile(root, path) {
  const full = resolve(root, path);
  if (!full.startsWith(resolve(root) + sep)) throw new Error('工程文件路径越界');
  return full;
}

export async function readProject(root, id, checkHash = false) {
  if (!PROJECT_ID.test(id || '')) throw new Error('工程不存在');
  const project = JSON.parse(await readFile(resolve(root, 'projects', id, 'project.json'), 'utf8'));
  if (project.id !== id || project.pipeline !== PIPELINE || !project.ready) throw new Error('Vocal2Midi 工程尚未完成');
  if (checkHash) {
    const score = await readFile(workspaceFile(root, project.files.score));
    if (createHash('sha256').update(score).digest('hex') !== project.scoreSha256) throw new Error('USTX 文件已被修改，请重新导入工程');
  }
  return project;
}

export async function removeProject(root, id) {
  if (!PROJECT_ID.test(id || '')) throw new Error('工程不存在');
  const directory = resolve(await realpath(root), 'projects', id);
  const target = await realpath(directory);
  if (target !== directory) throw new Error('不能删除通过目录链接指向的工程');
  await readProject(root, id);
  await rm(target, { recursive: true, maxRetries: 2 });
}

export async function listProjects(root) {
  let directories;
  try { directories = await readdir(resolve(root, 'projects'), { withFileTypes: true }); } catch { return []; }
  const projects = [];
  for (const dir of directories) {
    if (!dir.isDirectory() || !dir.name.startsWith('v2m-')) continue;
    try { projects.push(await readProject(root, dir.name)); } catch { /* Incomplete jobs are not catalog entries. */ }
  }
  return projects.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export function browserProject(project) {
  const { files, ...data } = project;
  return { ...data, sounds: SOUND_IDS.map(id => ({ id })),
    vocalsUrl: `/api/projects/${project.id}/files/vocals`, scoreFile: `/api/projects/${project.id}/files/score` };
}
