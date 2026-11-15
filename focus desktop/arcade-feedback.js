(() => {
  let audio;

  document.addEventListener("click", event => {
    const control = event.target.closest("button, .app-tab, input.phone-app-switch");
    if (!control || control.disabled || !event.isTrusted) return;
    try {
      audio ??= new AudioContext();
      const play = () => {
        const now = audio.currentTime;
        const tone = audio.createOscillator();
        const gain = audio.createGain();
        tone.type = "square";
        tone.frequency.setValueAtTime(630, now);
        tone.frequency.exponentialRampToValueAtTime(310, now + .065);
        gain.gain.setValueAtTime(.025, now);
        gain.gain.exponentialRampToValueAtTime(.001, now + .075);
        tone.connect(gain).connect(audio.destination);
        tone.start(now);
        tone.stop(now + .078);
      };
      if (audio.state === "running") play();
      else audio.resume().then(play).catch(() => {});
    } catch {
      // Button actions remain available when audio is unavailable.
    }
  }, { capture: true });

  window.addEventListener("ironwill-exit-warning", () => {
    const dialog = document.getElementById("cancel-payment");
    if (!dialog || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    dialog.getAnimations().forEach(animation => {
      if (animation.animationName === "arcade-exit-warning") animation.cancel();
    });
    dialog.classList.remove("iw-enter");
    dialog.classList.remove("arcade-exit-warning");
    void dialog.offsetWidth;
    dialog.classList.add("arcade-exit-warning");
  });
})();
