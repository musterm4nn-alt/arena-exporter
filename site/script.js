(() => {
  "use strict";
  const menu = document.querySelector("[data-menu]");
  const nav = document.querySelector("[data-nav]");
  if (menu && nav) {
    menu.addEventListener("click", () => {
      const open = nav.toggleAttribute("data-open");
      menu.setAttribute("aria-expanded", String(open));
    });
  }
  const year = document.querySelector("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());
})();
