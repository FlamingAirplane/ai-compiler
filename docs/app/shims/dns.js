export const lookup = (host, options, cb) => (typeof options === 'function' ? options : cb)(new Error('DNS is not available in the browser version.'));
export default { lookup };
