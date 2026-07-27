const navToggle = document.querySelector('.nav-toggle');
const siteNav = document.querySelector('.site-nav');

if (navToggle && siteNav) {
  navToggle.addEventListener('click', () => {
    const open = navToggle.getAttribute('aria-expanded') === 'true';
    navToggle.setAttribute('aria-expanded', String(!open));
    siteNav.classList.toggle('open', !open);
  });
}

const docsToggle = document.querySelector('.docs-toggle');
const docsSidebar = document.querySelector('.docs-sidebar');

if (docsToggle && docsSidebar) {
  docsToggle.addEventListener('click', () => {
    const open = docsToggle.getAttribute('aria-expanded') === 'true';
    docsToggle.setAttribute('aria-expanded', String(!open));
    docsSidebar.classList.toggle('open', !open);
  });
}

