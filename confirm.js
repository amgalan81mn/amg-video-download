const p = new URLSearchParams(location.search);
document.getElementById('file').textContent = p.get('file') || '';
document.querySelectorAll('button[data-a]').forEach((b) => {
  b.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'conflictAnswer', rid: p.get('rid'), answer: b.dataset.a }).catch(() => {});
    window.close();
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelector('[data-a=cancel]').click();
  if (e.key === 'Enter') document.querySelector('[data-a=rename]').click();
});
