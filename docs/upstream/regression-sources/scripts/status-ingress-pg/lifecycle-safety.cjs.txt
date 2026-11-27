const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
function privatePostgresUrl(value){try{const url=new URL(value);if(url.protocol!=='postgresql:'||!url.username||!url.password)throw Error();return url;}catch{throw Error('PRIVATE_POSTGRES_URL_INVALID');}}
async function dropOwnedDatabase({admin,receipt,name,role,profile,marker,maintenanceUrl,sourceCommit,openCleanup}){
 assert.match(name,/^cgp_core_status_[a-f0-9]{16}$/);assert.equal(role,name+'_app');
 const existing=(await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",[name])).rows[0];
 assert.equal(receipt.marker,marker);assert.equal(receipt.databaseName,name);assert.equal(receipt.role,role);
 assert.equal(receipt.profile??'MIGRATION_APPLY',profile,'receipt profile mismatch');
 assert.equal(receipt.sourceCommit,sourceCommit,'receipt source pin mismatch');
 assert.equal(receipt.maintenanceIdentitySha256,createHash('sha256').update(maintenanceUrl).digest('hex'));
 assert.equal(existing?.marker,marker+':'+receipt.ownershipNonce);
 assert.equal((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1',[name])).rows[0].n,0,'live connections remain; no forced cleanup');
 const ownedRole=(await admin.query("SELECT shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",[role])).rows[0];
 if(ownedRole)assert.equal(ownedRole.marker,marker+':'+receipt.ownershipNonce,'role ownership mismatch');
 // Reserve only after read-only validation, before destructive SQL. If DROP itself
 // refuses, remove only our still-empty, identity-checked file so exact retry works.
 const file=openCleanup();let dropped=false;
 try{await admin.query('DROP DATABASE "'+name+'"');dropped=true;file.write(JSON.stringify({label:'EXPLICIT_OWNED_MIGRATION_DATABASE_CLEANUP',databaseName:name,role,cleanup:'DATABASE_DROPPED_ROLE_CLEANUP_UNCONFIRMED'}));if(ownedRole)await admin.query('DROP ROLE "'+role+'"');file.write(JSON.stringify({label:'EXPLICIT_OWNED_MIGRATION_DATABASE_CLEANUP',databaseName:name,role,cleanup:'EXACT_OWNED_DATABASE_AND_ROLE_DROPPED'},null,2));}
 catch(error){if(!dropped)file.discardEmpty();else file.write(JSON.stringify({label:'EXPLICIT_OWNED_MIGRATION_DATABASE_CLEANUP',databaseName:name,role,cleanup:'DATABASE_DROPPED_ROLE_CLEANUP_UNCONFIRMED'}));throw error;}
 finally{file.close();}
}
module.exports={privatePostgresUrl,dropOwnedDatabase};
