/* Native Node loading is intentional: Vitest TS aliases must not transform Sequelize decorators. */
const path=require('node:path'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),ownerRequire=createRequire(path.join(root,'packages/core/package.json'));
function loadBuilt(){
 // Resolve the ORM's own declared peer; never borrow/install a root dependency.
 createRequire(ownerRequire.resolve('sequelize-typescript'))('reflect-metadata');
 const dal=path.join(root,'packages/core/dist/src/dal/layers/sequelize');
 const base=ownerRequire('@citrineos/base');
 return{...base,
  DefaultSequelizeInstance:ownerRequire(path.join(dal,'util.js')).DefaultSequelizeInstance,
  SequelizeLocationRepository:ownerRequire(path.join(dal,'repository/Location.js')).SequelizeLocationRepository,
  SequelizeOCPPMessageRepository:ownerRequire(path.join(dal,'repository/OCPPMessage.js')).SequelizeOCPPMessageRepository,
  StatusNotification:ownerRequire(path.join(dal,'model/Location/StatusNotification.js')).StatusNotification,
 };
}
module.exports={loadBuilt};
