export function selectPitchSource(project, requestedMode) {
  const native = project.nativeRender;
  const modes = native.pitchModes;
  if (!modes || typeof modes !== 'object') {
    if (requestedMode && requestedMode !== 'default') {
      throw new Error('此工程尚未生成所选音高轨，请重新分析工程');
    }
    return { mode: 'default', path: native.pitch };
  }
  const mode = requestedMode || project.pitchModeDefault || Object.keys(modes)[0];
  const selected = Object.hasOwn(modes, mode) ? modes[mode] : null;
  if (!selected || (selected.pitch == null && mode !== 'note-only')) throw new Error('未知的音高提取模式：' + mode);
  return { mode, path: selected.pitch };
}
