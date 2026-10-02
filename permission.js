document.getElementById('requestBtn').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    // Stop stream immediately after permission is granted
    stream.getTracks().forEach(track => track.stop());
    alert("Camera permission granted! You can close this tab and return to Songsterr.");
    window.close();
  } catch (err) {
    alert("Permission denied. Please allow camera access in browser settings.");
  }
});