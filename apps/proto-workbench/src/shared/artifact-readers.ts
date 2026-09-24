import catalog from "../../../../src/proto_agent/data/artifact-readers.json" with {type:"json"};

export type ArtifactReaderStatus="current"|"legacy-readonly"|"unsupported-version";
export interface ArtifactReaderSelection {
  family:string;schemaVersion:string|null;status:ArtifactReaderStatus;readOnly:boolean;
  code:"CURRENT_VERSION"|"LEGACY_READ_ONLY"|"UNSUPPORTED_VERSION";message:string;
}
/** Version routing never upgrades bytes or replaces domain/trust validation. */
export class ArtifactReaderRegistry {
  private readonly families=new Map<string,{current:ReadonlySet<string>;legacy:ReadonlySet<string>;versionField:string}>();
  register(family:string,current:string|readonly string[],legacy:readonly string[]=[],versionField="schema_version"):this {
    const versions=typeof current==="string"?[current]:current;
    if(this.families.has(family)||!versions.length||legacy.some(value=>versions.includes(value)))throw new Error(`Duplicate artifact reader registration: ${family}`);
    this.families.set(family,{current:new Set(versions),legacy:new Set(legacy),versionField});return this;
  }
  has(family:string){return this.families.has(family);}
  select(family:string,artifact:unknown):ArtifactReaderSelection {
    const reader=this.families.get(family),field=reader?.versionField??"schema_version";
    const schemaVersion=artifact&&typeof artifact==="object"&&!Array.isArray(artifact)&&typeof (artifact as Record<string,unknown>)[field]==="string"?(artifact as Record<string,string>)[field]:null;
    return this.version(family,schemaVersion);
  }
  inspect(artifact:unknown):ArtifactReaderSelection|undefined {
    if(!artifact||typeof artifact!=="object"||Array.isArray(artifact))return undefined;
    const object=artifact as Record<string,unknown>;
    const versions=[object.schema_version,object.schema,object.schemaVersion].filter((value):value is string=>typeof value==="string"&&/^proto(?:-agent|-workbench)?\..+\.v\d+$/.test(value));
    if(!versions.length)return undefined;
    const version=versions[0],family=version.replace(/\.v\d+$/,"");
    return this.version(family,new Set(versions).size===1?version:null);
  }
  private version(family:string,schemaVersion:string|null):ArtifactReaderSelection {
    const reader=this.families.get(family);
    const status:ArtifactReaderStatus=reader&&schemaVersion!==null&&reader.current.has(schemaVersion)?"current":reader&&schemaVersion!==null&&reader.legacy.has(schemaVersion)?"legacy-readonly":"unsupported-version";
    return {family,schemaVersion,status,readOnly:status!=="current",code:status==="current"?"CURRENT_VERSION":status==="legacy-readonly"?"LEGACY_READ_ONLY":"UNSUPPORTED_VERSION",
      message:status==="current"?"This version has a current reader; artifact integrity still requires verification.":status==="legacy-readonly"?`Legacy artifact ${schemaVersion} is retained for read-only metadata inspection; execution and linking are disabled.`:`Unsupported artifact version ${schemaVersion??"(missing or conflicting)"}. Original files are retained for read-only inspection; execution and linking are disabled.`};
  }
}
export const artifactReaderCatalog=catalog;
export const artifactReaders=new ArtifactReaderRegistry();
for(const entry of catalog.families){
  artifactReaders.register(entry.family,entry.current,entry.legacy,entry.versionField);
  if(entry.alias)artifactReaders.register(entry.alias,entry.current,entry.legacy,entry.versionField);
}
