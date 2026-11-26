'use strict';

const frames = ['|', '/', '-', '\\'];

async function withLoading(message, action, stream = process.stderr) {
  if (!stream.isTTY) {
    stream.write(message + '\n');
    return action();
  }

  let frame = 0;
  const draw = () => {
    stream.write('\r\x1b[2K' + frames[frame] + ' ' + message);
    frame = (frame + 1) % frames.length;
  };
  draw();
  const timer = setInterval(draw, 100);
  timer.unref();
  try {
    return await action();
  } finally {
    clearInterval(timer);
    stream.write('\r\x1b[2K');
  }
}

module.exports = { withLoading };
