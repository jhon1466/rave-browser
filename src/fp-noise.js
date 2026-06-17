(function(){
  try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const img = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < img.data.length; i += 100) img.data[i] ^= 1;
        ctx.putImageData(img, 0, 0);
      }
      return origToDataURL.apply(this, args);
    };
  } catch(e) {}
})();