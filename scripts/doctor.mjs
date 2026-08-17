const major = Number(process.versions.node.split('.')[0]);
if (major < 20) { console.error('Node.js 20+ required'); process.exit(1); }
console.log(`Node ${process.versions.node}: OK`);
console.log('NNIT Studio workspace: OK');
