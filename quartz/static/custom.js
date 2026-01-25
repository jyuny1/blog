
function initGallery() {
  const contentElement = document.querySelector(".content");
  if (!contentElement || !window.lightGallery) return;

  const images = contentElement.querySelectorAll("img");
  images.forEach(img => {
    if (img.closest("a")) return;
    
    const anchor = document.createElement("a");
    anchor.href = img.src;
    anchor.className = "lg-image";
    anchor.setAttribute("data-src", img.src);
    
    // Maintain the image style (like width)
    if (img.getAttribute("width")) {
        anchor.style.display = "inline-block";
    }

    img.parentNode.insertBefore(anchor, img);
    anchor.appendChild(img);
  });

  // Initialize with global plugin names from CDN
  lightGallery(contentElement, {
    plugins: [window.lgThumbnail, window.lgZoom, window.lgFullscreen],
    selector: ".lg-image",
    speed: 500,
    licenseKey: "0000-0000-000-0000"
  });
}

document.addEventListener("nav", () => {
  // Quartz SPA navigation: cleanup and re-init
  setTimeout(initGallery, 500);
});
