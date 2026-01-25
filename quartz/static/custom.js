document.addEventListener("nav", () => {
  // Wait a bit for images to be ready or scripts to load
  setTimeout(() => {
    const images = document.querySelectorAll(".content img");
    if (images.length === 0) return;

    // Wrap each image in an anchor tag for lightGallery if not already wrapped
    images.forEach(img => {
      // Avoid double wrapping and check if it is part of a link already
      if (img.closest("a")) return;
      
      const anchor = document.createElement("a");
      anchor.href = img.src;
      anchor.className = "lg-image";
      anchor.setAttribute("data-src", img.src);
      img.parentNode.insertBefore(anchor, img);
      anchor.appendChild(img);
    });

    // Initialize lightGallery
    if (window.lightGallery) {
      const contentElement = document.querySelector(".content");
      if (contentElement) {
          // If instance exists, destroy it first to avoid duplicates on navigation
          if (contentElement.lgData) {
              // Note: lightGallery v2 stores data on the element
          }
          lightGallery(contentElement, {
            plugins: [lgThumbnail, lgZoom, lgFullscreen],
            selector: ".lg-image",
            speed: 500,
            licenseKey: "0000-0000-000-0000"
          });
      }
    }
  }, 500);
});
