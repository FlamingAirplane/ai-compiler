export const spawn = () => {
  throw new Error('Running programs is not available in the browser version.');
};
export const spawnSync = spawn;
export default { spawn, spawnSync };
