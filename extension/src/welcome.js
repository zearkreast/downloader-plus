// The welcome page as a short tour: one step at a time, with Back, Next and a
// way out. Without this script every step simply shows, one under another.

(function tour() {
  const steps = [...document.querySelectorAll('[data-step]')];
  const controls = document.querySelector('.controls');
  const progress = document.getElementById('progress');
  const dots = document.getElementById('dots');
  const skip = document.getElementById('skip');
  const back = document.getElementById('back');
  const next = document.getElementById('next');
  if (steps.length < 2 || !controls || !next) return;

  const say = (key, fallback) => chrome.i18n.getMessage(key) || fallback;
  let index = 0;

  for (let dot = 0; dot < steps.length; dot += 1) dots.append(document.createElement('span'));

  // A tab the extension opened can close itself; one opened some other way is
  // left to its owner, and the last step stays on screen.
  async function close() {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id != null) await chrome.tabs.remove(tab.id);
    } catch {
      // Nothing to close from here.
    }
  }

  function show(at) {
    index = Math.max(0, Math.min(steps.length - 1, at));
    steps.forEach((step, position) => {
      step.hidden = position !== index;
    });
    [...dots.children].forEach((dot, position) => dot.classList.toggle('on', position === index));
    progress.textContent = `${index + 1} / ${steps.length}`;
    const last = index === steps.length - 1;
    back.hidden = index === 0;
    skip.hidden = last;
    next.textContent = index === 0
      ? say('tourStart', 'Start')
      : last
        ? say('tourFinish', 'Done')
        : say('tourNext', 'Next');
    next.focus({ preventScroll: true });
  }

  next.addEventListener('click', () => {
    if (index === steps.length - 1) void close();
    else show(index + 1);
  });
  back.addEventListener('click', () => show(index - 1));
  skip.addEventListener('click', () => show(steps.length - 1));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') show(index + 1);
    else if (event.key === 'ArrowLeft') show(index - 1);
  });

  controls.hidden = false;
  document.body.classList.add('touring');
  show(0);
})();
