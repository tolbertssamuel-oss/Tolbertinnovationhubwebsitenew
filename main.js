document.querySelectorAll('form.form-card').forEach((form) => {
  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const feedback = form.querySelector('.form-feedback');
    const message = form.dataset.successMessage || 'Form submitted successfully.';

    if (!form.checkValidity()) {
      feedback.textContent = 'Please complete all required fields before submitting.';
      feedback.style.color = '#b42318';
      form.reportValidity();
      return;
    }

    const data = new FormData(form);
    const entries = Object.fromEntries(data.entries());
    console.log('Form submission preview:', entries);

    feedback.textContent = message;
    feedback.style.color = '#0b5a32';
    form.reset();
  });
});

const navWrap = document.querySelector('.nav-wrap');
const navLinks = navWrap?.querySelector('.nav-links');
const siteHeader = document.querySelector('.site-header');

function wireAutoHideHeader() {
  if (!siteHeader) return;

  let lastScrollY = window.scrollY;
  const threshold = 8;

  window.addEventListener('scroll', () => {
    const currentY = window.scrollY;
    const delta = currentY - lastScrollY;
    const menuOpen = navWrap?.classList.contains('nav-open');

    if (currentY <= 40 || menuOpen) {
      siteHeader.classList.remove('header-hidden');
      lastScrollY = currentY;
      return;
    }

    if (delta > threshold) {
      siteHeader.classList.add('header-hidden');
    } else if (delta < -threshold) {
      siteHeader.classList.remove('header-hidden');
    }

    lastScrollY = currentY;
  }, { passive: true });
}

if (navWrap && navLinks) {
  if (!navLinks.id) {
    navLinks.id = 'primary-navigation';
  }

  const brand = navWrap.querySelector('.brand');
  if (brand && !brand.querySelector('.brand-logo')) {
    const brandText = brand.textContent.trim();
    brand.textContent = '';

    const logo = document.createElement('img');
    logo.className = 'brand-logo';
    logo.src = 'https://i.ibb.co/SXJKRq0S/Tolbert-Innovation-Logo.jpg';
    logo.alt = 'Tolbert Innovation Hub logo';
    logo.width = 48;
    logo.height = 48;

    const text = document.createElement('span');
    text.className = 'brand-text';
    text.textContent = brandText || 'Tolbert Innovation Hub';

    brand.append(logo, text);
  }

  let menuButton = navWrap.querySelector('.menu-toggle');
  if (!menuButton) {
    menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'menu-toggle';
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-controls', navLinks.id);
    menuButton.setAttribute('aria-label', 'Toggle navigation menu');
    menuButton.innerHTML = '<span aria-hidden="true">☰</span> Menu';

    if (brand) {
      brand.insertAdjacentElement('afterend', menuButton);
    } else {
      navWrap.prepend(menuButton);
    }
  }

  const closeMenu = () => {
    navWrap.classList.remove('nav-open');
    menuButton.setAttribute('aria-expanded', 'false');
  };

  menuButton.addEventListener('click', () => {
    const shouldOpen = !navWrap.classList.contains('nav-open');
    navWrap.classList.toggle('nav-open', shouldOpen);
    menuButton.setAttribute('aria-expanded', String(shouldOpen));
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 920) {
      closeMenu();
    }
  });
}

wireAutoHideHeader();
