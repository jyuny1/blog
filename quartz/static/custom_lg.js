let lgInstance = null;

function cleanupStaleWrappers() {
  document.querySelectorAll('img.lg-wrapped').forEach(img => {
    if (!img.closest('.lg-image')) {
      img.classList.remove('lg-wrapped');
    }
  });
}

function initGallery() {
  console.log("LightGallery: [Diagnostic] Starting initialization...");
  
  // Find content wrapper
  const contentElement = document.querySelector("article") || document.querySelector(".content") || document.querySelector("main");
  
  if (!contentElement) {
    console.warn("LightGallery: [Error] No content wrapper found. Lightbox cannot start.");
    return;
  }
  
  // library check
  if (typeof lightGallery === "undefined") {
    console.error("LightGallery: [Error] Library lightGallery is not defined.");
    return;
  }

  cleanupStaleWrappers();

  const images = contentElement.querySelectorAll("img");
  let wrapCount = 0;
  
  images.forEach((img) => {
    if (img.closest(".lg-image") || img.closest("a")) return;
    if (img.width > 0 && img.width < 50 && !img.getAttribute("width")) return;

    const anchor = document.createElement("a");
    anchor.href = img.src;
    anchor.className = "lg-image";
    anchor.setAttribute("data-src", img.src);
    img.classList.add("lg-wrapped");
    anchor.setAttribute("data-sub-html", " ");
    
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

  // Re-collect all lg-image elements in current DOM
  const galleryItems = contentElement.querySelectorAll(".lg-image");

  if (galleryItems.length > 0) {
    try {
      if (lgInstance) {
        lgInstance.destroy();
        lgInstance = null;
      }

      const plugins = [];
      if (window.lgThumbnail) plugins.push(window.lgThumbnail);
      if (window.lgZoom) plugins.push(window.lgZoom);
      if (window.lgFullscreen) plugins.push(window.lgFullscreen);
      
      lgInstance = lightGallery(contentElement, {
        plugins: plugins,
        selector: ".lg-image",
        speed: 500,
        licenseKey: "0000-0000-000-0000",
        getCaptionFromTitleOrAlt: false,
        mobileSettings: {
            controls: true,
            showCloseIcon: true,
            download: false
        }
      });
      console.log("LightGallery: [Success] Initialization complete on " + galleryItems.length + " items.");
    } catch (e) {
      console.error("LightGallery: [Error] Initialization failed:", e);
    }
  }
}

// Global observer to catch DOM changes missed by events
let observer = null;
function setupObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                const article = document.querySelector('article');
                if (article && !article.querySelector('.lg-image')) {
                    // Content changed but images not wrapped
                    initGallery();
                    break;
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

// Standard Event Listeners
document.addEventListener("nav", () => {
  console.log("LightGallery: [Event] Quartz Nav.");
  setTimeout(initGallery, 50); // Faster trigger
  setTimeout(initGallery, 500); // Backup trigger
});

window.addEventListener("load", () => {
  initGallery();
  setupObserver();
});

// Immediate execution if script re-added/persisted
initGallery();
setupObserver();
