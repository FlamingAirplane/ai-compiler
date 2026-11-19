const unavailable = () => {
  throw new Error('Direct network requests are not available in the browser version.');
};
export const request = unavailable;
export default { request };
