function initGallery() {
  // Quartz usually puts content in an article tag
  const contentElement = document.querySelector("article");
  if (!contentElement) {
    console.log("LightGallery: No article element found.");
    return;
  }
  
  if (typeof lightGallery === "undefined") {
    console.log("LightGallery: lightGallery library not loaded yet.");
    return;
  }

  const images = contentElement.querySelectorAll("img");
  let found = false;
  images.forEach(img => {
    // Skip if already wrapped in a link
    if (img.closest("a")) return;
    
    // Skip small icons or specific classes if needed
    if (img.classList.contains("emoji") || (img.width > 0 && img.width < 50)) return;

    found = true;
    const anchor = document.createElement("a");
    anchor.href = img.src;
    anchor.className = "lg-image";
    anchor.setAttribute("data-src", img.src);
    
    // Maintain the image style (like width)
    const width = img.getAttribute("width");
    if (width) {
        anchor.style.display = "inline-block";
        // If width is just a number, append px
        anchor.style.width = isNaN(width) ? width : width + "px";
    }

    img.parentNode.insertBefore(anchor, img);
    anchor.appendChild(img);
  });

  if (found) {
    console.log("LightGallery: Initializing on images.");
    try {
      lightGallery(contentElement, {
        plugins: [lgThumbnail, lgZoom, lgFullscreen],
        selector: ".lg-image",
        speed: 500,
        licenseKey: "0000-0000-000-0000"
      });
    } catch (e) {
      console.error("LightGallery initialization failed:", e);
    }
  }
}

// Quartz SPA navigation
document.addEventListener("nav", () => {
  console.log("Quartz Nav event detected");
  setTimeout(initGallery, 500);
});

// Initial load
if (document.readyState === "complete") {
  initGallery();
} else {
  window.addEventListener("load", initGallery);
}
