// Transcript page interactions: header actions, copy buttons, tool toggle, jump-to-latest.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  document.addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-cmd]');
    if (cmd) {
      vscode.postMessage({ command: cmd.dataset.cmd });
      return;
    }
    const copy = e.target.closest('.copy-code');
    if (copy) {
      const code = copy.closest('.code-block')?.querySelector('code')?.innerText ?? '';
      vscode.postMessage({ command: 'copyText', text: code });
      const icon = copy.querySelector('.codicon');
      icon.classList.replace('codicon-copy', 'codicon-check');
      setTimeout(() => icon.classList.replace('codicon-check', 'codicon-copy'), 1200);
    }
  });

  const toggle = document.getElementById('show-tools');
  const applyTools = () => document.body.classList.toggle('hide-tools', !!toggle && !toggle.checked);
  if (toggle) {
    toggle.checked = saved.showTools !== false;
    toggle.addEventListener('change', () => {
      vscode.setState({ ...saved, showTools: toggle.checked });
      saved.showTools = toggle.checked;
      applyTools();
    });
    applyTools();
  }

  // Compact top bar gets a shadow once the hero scrolls away; the jump button shows when far from the bottom.
  const jump = document.getElementById('jump');
  const onScroll = () => {
    const y = window.scrollY;
    document.body.classList.toggle('scrolled', y > 8);
    const fromBottom = document.documentElement.scrollHeight - (y + window.innerHeight);
    jump.classList.toggle('visible', fromBottom > 600);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  jump.addEventListener('click', () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));

  // Open at the latest message, like a chat.
  window.scrollTo(0, document.documentElement.scrollHeight);
  onScroll();
})();
