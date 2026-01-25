function initGallery() {
  console.log("LightGallery: Attempting to initialize...");
  
  // Try multiple common Quartz content wrappers
  const contentElement = document.querySelector("article") || document.querySelector(".content") || document.querySelector("main");
  
  if (!contentElement) {
    console.warn("LightGallery: No content wrapper found (article, .content, or main).");
    return;
  }
  
  if (typeof lightGallery === "undefined") {
    console.error("LightGallery: lightGallery library not loaded.");
    return;
  }

  const images = contentElement.querySelectorAll("img");
  console.log(`LightGallery: Found ${images.length} images in content.`);
  
  let wrapCount = 0;
  images.forEach(img => {
    // Skip if already wrapped in a link or is an icon
    if (img.closest("a")) return;
    if (img.classList.contains("emoji") || (img.width > 0 && img.width < 50)) return;

    const anchor = document.createElement("a");
    anchor.href = img.src;
    anchor.className = "lg-image";
    anchor.setAttribute("data-src", img.src);
    
    // Copy width to anchor to maintain layout
    const width = img.getAttribute("width");
    if (width) {
        anchor.style.display = "inline-block";
        anchor.style.width = isNaN(width) ? width + "px" : width;
    }

    if (img.parentNode) {
      img.parentNode.insertBefore(anchor, img);
      anchor.appendChild(img);
      wrapCount++;
    }
  });

  if (wrapCount > 0) {
    console.log(`LightGallery: Wrapped ${wrapCount} images. Initializing gallery...`);
    try {
      // Use window. prefix to be safe with global variables
      const plugins = [];
      if (typeof window.lgThumbnail !== "undefined") plugins.push(window.lgThumbnail);
      if (typeof window.lgZoom !== "undefined") plugins.push(window.lgZoom);
      if (typeof window.lgFullscreen !== "undefined") plugins.push(window.lgFullscreen);
      
      lightGallery(contentElement, {
        plugins: plugins,
        selector: ".lg-image",
        speed: 500,
        licenseKey: "0000-0000-000-0000",
        download: true,
        counter: true
      });
      console.log("LightGallery: Initialization successful.");
    } catch (e) {
      console.error("LightGallery: initialization failed:", e);
    }
  } else {
    console.log("LightGallery: No images were wrapped.");
  }
}

// Quartz SPA navigation
document.addEventListener("nav", () => {
  console.log("LightGallery: Quartz Nav event detected");
  // Small delay to ensure DOM is ready
  setTimeout(initGallery, 300);
});

// Initial load
if (document.readyState === "complete") {
  initGallery();
} else {
  window.addEventListener("load", () => {
    setTimeout(initGallery, 300);
  });
}
