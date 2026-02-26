(function () {
  "use strict";

  const ttlInput = document.getElementById("ttl");
  const saveBtn = document.getElementById("save");
  const status = document.getElementById("status");

  // Load saved value
  browser.storage.local.get("cacheTtlHours").then((result) => {
    if (result.cacheTtlHours != null) {
      ttlInput.value = result.cacheTtlHours;
    }
  });

  saveBtn.addEventListener("click", () => {
    const val = parseFloat(ttlInput.value);
    if (isNaN(val) || val < 0) {
      status.textContent = "Invalid value";
      status.style.color = "#c62828";
      return;
    }

    browser.storage.local.set({ cacheTtlHours: val }).then(() => {
      status.textContent = "Saved";
      status.style.color = "#409D69";
      setTimeout(() => { status.textContent = ""; }, 2000);
    });
  });
})();
