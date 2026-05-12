/* Stub Prisma client for smoke tests — never touches a real database.
 * Each method returns sensible empty defaults so route handlers don't crash.
 */

const noop = async () => {};
const findManyEmpty = async () => [];
const findFirstNull = async () => null;
const findUniqueNull = async () => null;

const tableProxy = {
  findMany: findManyEmpty,
  findFirst: findFirstNull,
  findUnique: findUniqueNull,
  create: async ({ data }) => ({ id: 1, ...data }),
  update: async ({ data }) => ({ id: 1, ...data }),
  updateMany: async () => ({ count: 0 }),
  delete: noop,
  deleteMany: async () => ({ count: 0 }),
  count: async () => 0,
};

module.exports = new Proxy({}, {
  get(_target, key) {
    if (key === '$executeRawUnsafe') return async () => 0;
    if (key === '$executeRaw')       return async () => 0;
    if (key === '$queryRaw')         return async () => [];
    if (key === '$transaction')      return async (fnOrArr) => {
      if (typeof fnOrArr === 'function') return fnOrArr(module.exports);
      return Promise.all(fnOrArr);
    };
    if (key === '$disconnect' || key === '$connect') return noop;
    return tableProxy;
  }
});
