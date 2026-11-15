(() => {
  const source = new URL("./assets/ironwill-quack.ogg", document.baseURI).href;
  const cues = {
    normal: { volume: .28, rate: .86, duration: 780 },
    emergency: { volume: 1, rate: 1.28, duration: 2000 },
    warning: { volume: .76, rate: 1.07, duration: 780 },
    angry: { volume: 1, rate: .92, duration: 1450 },
  };
  const audio = new Audio(source);
  audio.preload = "auto";
  let stop;
  let playback = 0;

  function play(kind) {
    const cue = cues[kind];
    if (!cue) return;
    const request = ++playback;
    clearTimeout(stop);
    audio.pause();
    audio.currentTime = 0;
    audio.volume = cue.volume;
    audio.playbackRate = cue.rate;
    audio.play().then(() => {
      if (request === playback) stop = setTimeout(() => audio.pause(), cue.duration);
    }).catch(error => {
      if (request === playback) console.warn("IronWill quack playback failed:", error.name);
    });
  }

  window.ironWillSound = { play };
})();
