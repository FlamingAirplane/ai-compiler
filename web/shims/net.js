export const isIP = (s) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? 4 : /:/.test(s) ? 6 : 0);
export default { isIP };
