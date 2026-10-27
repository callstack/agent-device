// The hero animation, loaded on demand by Hero.astro. There is a tab per job (build, verify,
// profile); the loop plays each in turn: the prompt appears, then the agent's tool calls land one
// by one. Choosing a tab stops the loop and shows that job in full. The page renders every job in
// full (the still frame); under reduced motion only the tabs work.
import { sleep, whenVisible } from '../site/anim';

export default function runHero(viz: HTMLElement) {
  const tabs = [...viz.querySelectorAll<HTMLButtonElement>('[data-job-tab]')];
  const panels = [...viz.querySelectorAll<HTMLElement>('[data-job]')];
  if (!tabs.length || tabs.length !== panels.length) return;
  const steps = panels.map((panel) => [...panel.querySelectorAll<HTMLElement>('[data-step]')]);

  let stopped = false;

  const select = (index: number) => {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i]!.hidden = i !== index;
    });
  };
  const showAll = (index: number) =>
    steps[index]!.forEach((step) => step.classList.remove('is-hidden', 'is-in'));

  const choose = (index: number) => {
    stopped = true;
    select(index);
    showAll(index);
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => choose(i));
    tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = (i + step + tabs.length) % tabs.length;
      choose(next);
      tabs[next]!.focus();
    });
  });

  let current = 0;
  const play = async () => {
    if (stopped) return sleep(1000);
    select(current);
    const own = steps[current]!;
    own.forEach((step) => step.classList.add('is-hidden'));
    await sleep(400);
    for (const [i, step] of own.entries()) {
      if (stopped) return;
      step.classList.remove('is-hidden');
      step.classList.add('is-in');
      // The prompt is read first; each call lands a beat after the last.
      await sleep(i === 0 ? 1100 : 650);
    }
    await sleep(3200);
    if (!stopped) current = (current + 1) % panels.length;
  };

  // Under reduced motion the server-rendered jobs stay in full, and the tabs still switch.
  whenVisible(viz, play, () => {});
}
