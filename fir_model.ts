import moment from 'moment';

const MroMap = new Map();
// const KeysMap = new Map();
// const PatchKeysMap = new Map();
export const ModelRegistry = new Map();
export const UnresolvedSchemas = new Set();
const ChildClassMap = new Map();

const MetaSymbol = Symbol('ModelMeta');
import {FirInterop} from './fir_interop';
import {FirError} from './fir_error';


export class ModelMeta {
    model : Model;
    constructor(model:Model) {
        this.model = model;
        this.name = model.name;
        this.children = new Set();
        this.parent = null;
        if(model !== Model) {
            this.parent = Object.getPrototypeOf(model)
            // console.log("Adding ", model.name, " to ", parent.name )
            this.parent.__meta__.children.add(model);
        }
        if(this.parent) {
            this.mro = [...this.parent.__meta__.mro, model]
        } else {
            this.mro = [model];
        }

        this.parse_schema();
        this.parse_contracts();

        // this.mro = this.calculate_mro();
    }
    parse_schema() {
        // this.schema = new Map();
        // if I have a parent, assign that on.
        if(this.parent) {
            this.schema = new Map(this.parent.__meta__.schema);
            // Object.assign(this.schema, this.parent.__meta__.schema);
        } else {
            this.schema = new Map();
        }
        this.default_contract_tokens = [];


        // now write my own on.
        if(Object.hasOwn(this.model, '__schema__')) {

            for(var [field, def] of Object.entries(this.model.__schema__)) {
                // if it's not an object like {type: some_type_function, ...}
                if(!(
                    def && typeof(def) === 'object'
                    && def.type && (typeof(def.type) === 'function' || def.type instanceof Array)
                )) {
                    // then this must be a direct shorthand type,
                    //either type or [type]
                    def = {type: def, field: field};
                }
                def.field = field;

                if(def.field.startsWith('$')) {
                    this.default_contract_tokens.push(def.field);
                    def.field = def.field.substring(1);
                    field = def.field;
                } else if(def.field.startsWith('_')) {
                    // implicitly delete it in case this schema is hiding a parent field
                    this.default_contract_tokens.push('-' + def.field);
                } else {
                    this.default_contract_tokens.push(def.field);
                }

                if(def.type instanceof Array) {
                    // for now, arrays must be homogenous
                    // though polymorphism is allowed
                    if(def.type.length != 1) {
                        throw new Error(`Schema error for ${this.model.name}.${field}: type array must have exactly 1 type.`);
                    }
                    def.type = def.type[0];
                    def.is_array = true;
                }
                if(typeof def.type === 'string') {
                    // this is a forward reference.
                    // if it exists, use it now.
                    if(ModelRegistry.has(def.type)) {
                        def.type = ModelRegistry.get(def.type);
                    } else {
                        // otherwise store it but mark it.
                        def.unresolved = true;
                        this.unresolved_schema = true;

                        // and record this model as unresolved.
                        UnresolvedSchemas.add(this);
                    }
                } else if(!(typeof def.type === 'function' && def.type.prototype)) {
                    throw new Error(`Schema error for ${this.model.name}.${field}: type does not seem to be a type with prototype, it's ${def.type}`);
                }

                if(Model.isPrototypeOf(def.type)) {
                    def.is_model = true;
                }

                this.schema.set(field, def);
                // now construct a setter function for this field.
                let safe_setter = this.create_safe_setter(def);
                def.safe_setter = safe_setter;



            }

        }


    }
    register(name) {
        name = name === undefined ? this.model.name : name;
        if(name) {
            if(ModelRegistry.has(name)) {
                console.warn(`${name} is being re-registered in the Model class registry.`)
            }
            ModelRegistry.set(name, this.model);
        }
        // search unresolved schemas for this.
        for(var unresolved of UnresolvedSchemas) {
            let resolved_some = false;
            for(var [field, def] of unresolved.schema) {
                if(def.unresolved && def.type == name) {
                    // resolve this one.
                    def.type = this.model;
                    if(Model.isPrototypeOf(def.type)) {
                        def.is_model = true;
                    }

                    delete def.unresolved;

                    resolved_some = true;
                }
            }
            // if we resolved it some, and it's now fully resolved
            if(resolved_some && [...unresolved.schema].every(([field, def])=>!def.unresolved)) {
                // unmark it
                unresolved.unresolved_schema = false;
                // and remove it from the cached list.
                UnresolvedSchemas.delete(unresolved);
            }
        }

        // if we're in dev, put the class onto window.
        if (typeof window !== 'undefined' && import.meta.env.DEV) {
            if (name) window[name] = this.model;    
        }
    }
    parse_contracts() {
        this.contracts = new Map();
        this.contract_recipes = new Map(); // name->['key', '$key', '-key', '*import']
        // recipes are first copied from the parent
        if(this.parent) {
            for(var [name, fields] of this.parent.__meta__.contract_recipes) {
                this.contract_recipes.set(name, [...fields]);
            }
        }

        // then we apply the default contracts from the schema
        if(this.default_contract_tokens.length && !this.contract_recipes.has('default')) {
            this.contract_recipes.set('default', []);                    
        }
        for(let token of this.default_contract_tokens) {
            this.contract_recipes.get('default').push(token);
        }


        // then this model's contracts are appended to the end of each recipe
        if(Object.hasOwn(this.model, '__contracts__')) {
            for(var [name, fields] of Object.entries(this.model.__contracts__)) {
                if(!this.contract_recipes.has(name)) {
                    this.contract_recipes.set(name, []);
                }
                this.contract_recipes.get(name).push(...fields);
            }
        }
        // next expandt the recipes' imports, careful of recursion.
        var expanded_recipes = new Map();
        const processing = [];
        const expand_imports = (name)=>{
            if(processing.includes(name)) {
                throw new Error(`Circular contract definition while processing ${this.model.name}: ${processing}`);
            }
            processing.push(name);

            var expanded = [];
            for(var token of this.contract_recipes.get(name)) {
                if(token.startsWith('*')) {
                    // it's an import
                    var import_name = token.substring(1);
                    if(!expanded_recipes.has(import_name)) {
                        if(!this.contract_recipes.get(import_name)) {
                            throw new Error(`Unknown contract import on model ${this.model.name}, contract ${name} importing ${import_name}`);
                        }
                        expand_imports(import_name);
                    }
                    expanded.push(...expanded_recipes.get(import_name));
                } else {
                    expanded.push(token);
                }
            }
            expanded_recipes.set(name, expanded);
            processing.pop();
        }

        for( var [name, recipe] of this.contract_recipes ) {
            expand_imports(name);
        }

        this.contracts = new Map(); // name->{transport:[], patch:[]}
        const get_setter = (field)=>{
            return this.schema.get(field)?.safe_setter || ((inst, val) => inst[field] = val);
        }
        const parse_recipe = (name, recipe)=>{
            const contract = {
                transport: new Map(),
                patch: new Map(),
            };
            for(var token of recipe) {
                if(token.startsWith('$')) {
                    const field = token.substring(1);
                    const setter = get_setter(field);
                    contract.transport.set(field, setter);
                    contract.patch.set(field, setter);;
                } else if(token.startsWith('-')) {
                    let removeThis = token.substring(1);
                    if(removeThis.startsWith('$')) {
                        removeThis = token.substring(1);
                    }
                    contract.transport.delete(removeThis);
                    contract.patch.delete(removeThis);
                } else {
                    const setter = get_setter(token);
                    contract.transport.set(token, setter);
                }
            }
            
            this.contracts.set(name, contract);
            // processing.pop();

        }
        for(var [name, recipe] of expanded_recipes) {
            parse_recipe(name, recipe);
        }

    }
    create_safe_setter(def) {
        let field = def.field;

        let safe_setter;
        if(def.is_array) {
            if(def.type === String) {
                safe_setter = (inst, val)=>{
                    if(!(val instanceof Array)) {
                        throw new Error(`When deserializing, cannot assign non-array ${val} to ${this.name}.${field}; it must be [${def.type.name}].`);
                    }
                    if(!val.every(v=>v === null || typeof v === 'string')) {
                        throw new Error(`When deserializing, cannot assign ${this.name}.${field} to ${val}; ; it must be [${def.type.name}].`);
                    }
                    inst[field] = val;
                };
            } else if(def.type === Number) {
                safe_setter = (inst, val)=>{
                    if(!(val instanceof Array)) {
                        throw new Error(`When deserializing, cannot assign non-array ${val} to ${this.name}.${field}; it must be [${def.type.name}].`);
                    }
                    if(!val.every(v=>v === null || typeof v === 'number')) {
                        throw new Error(`When deserializing, cannot assign ${this.name}.${field} to ${val}; ; it must be [${def.type.name}].`);
                    }
                    inst[field] = val;
                };
            } else if(def.type === BigInt) {
                safe_setter = (inst, val)=>{
                    if(!(val instanceof Array)) {
                        throw new Error(`When deserializing, cannot assign non-array ${val} to ${this.name}.${field}; it must be [${def.type.name}].`);
                    }
                    if(!val.every(v=>v === null || typeof v === 'number' || typeof v === 'bigint')) {
                        throw new Error(`When deserializing, cannot assign ${this.name}.${field} to ${val}; ; it must be [${def.type.name}].`);
                    }
                    inst[field] = val;
                };
            } else if(def.type === Boolean) {
                safe_setter = (inst, val)=>{
                    if(!(val instanceof Array)) {
                        throw new Error(`When deserializing, cannot assign non-array ${val} to ${this.name}.${field}; it must be [${def.type.name}].`);
                    }
                    if(!val.every(v=>v === null || typeof v === 'boolean' || v === 0 || v === 1)) {
                        throw new Error(`When deserializing, cannot assign ${this.name}.${field} to ${val}; ; it must be [${def.type.name}].`);
                    }
                    for(let i = 0; i < val.length; i++) {
                        if(val[i] !== null) val[i] = !!val[i];
                    }
                    inst[field] = val;
                };
            } else {
                safe_setter = (inst, val)=>{
                    if(!(val instanceof Array)) {
                        throw new Error(`When deserializing, cannot assign non-array ${val} to ${this.name}.${field}; it must be [${def.type.name}].`);
                    }
                    if(!val.every(v=>v === null || v instanceof def.type)) {
                        throw new Error(`When deserializing, cannot assign ${this.name}.${field} to ${val}; ; it must be [${def.type.name}].`);
                    }
                    inst[field] = val;
                };
            }
        }
        else {
            if(def.type === String) {
                safe_setter = (inst, val)=>{
                    if(!(val === null || typeof val === 'string')) {
                        throw new Error(`When deserializing, cannot assign ${this.name}.${field} to ${val}; ; it must be ${def.type.name}.`);
                    }
                    inst[field] = val;
                };
            } else if(def.type === Number) {
                safe_setter = (inst, val)=>{
                    if(!(val === null || typeof val === 'number')) {
                        throw new Error(`When deserializing, cannot assign ${this.name}.${field} to ${val}; ; it must be ${def.type.name}.`);
                    }
                    inst[field] = val;
                };
            } else if(def.type === BigInt) {
                safe_setter = (inst, val)=>{
                    if(!(val === null || typeof val === 'number' || typeof val === 'bigint')) {
                        throw new Error(`When deserializing, cannot assign ${this.name}.${field} to ${val}; ; it must be ${def.type.name}.`);
                    }
                    inst[field] = val;
                };
            } else if(def.type === Boolean) {
                safe_setter = (inst, val)=>{
                    if(!(val === null || typeof val === 'boolean' || val === 0 || val === 1)) {
                        throw new Error(`When deserializing, cannot assign ${this.name}.${field} to ${val}; ; it must be ${def.type.name}.`);
                    }
                    inst[field] = val === null ? val : !!val;
                };
            } else {
                safe_setter = (inst, val)=>{
                    if(!(val === null || val instanceof def.type)) {
                        throw new Error(`When deserializing, cannot assign ${this.name}.${field} to ${val}; ; it must be ${def.type.name}.`);
                    }
                    inst[field] = val;
                };
            }
        }
        return safe_setter;
    }
}


export class Model {

    constructor() {
        this.pk = null;
        Object.defineProperty(this, FirInterop.TPK, {
            value: FirInterop.TPK_INCREMENTER++,
            enumerable: false,
            configurable: true,
            writable: true
        });

    }
    // get obs() {
    //     return this[ObsStoreSymbol];
    // }
    static get __metaclass__() {
        return ModelMeta;
    }
    static get __meta__() {

        if(!Object.hasOwn(this, MetaSymbol)) {
            this[MetaSymbol] = new this.__metaclass__(this);
        }
        return this[MetaSymbol];
    }
    static get __mro__() {
        return this.__meta__.mro;
        // var mro = MroMap.get(this) || [];
        // if(mro.length) return mro;
        
        // var kls = this;
        // var mro = [];
        // while(kls && kls != Function.prototype) {
        //     mro.push(kls);
        //     kls = Object.getPrototypeOf(kls);
        // }
        // MroMap.set(this, mro);
        // return mro;
    }
    // static get __all_keys__() {

    //     // this is the child prototype
    //     var keys = KeysMap.get(this);
    //     if(keys) return keys;

    //     keys = [];
    //     var kls = this;
    //     const mro = this.__mro__;

    //     for(var x = mro.length - 1; x >= 0; x--) {
    //         if(mro[x].hasOwnProperty('__keys__')) {
    //             keys.push(...mro[x].__keys__);
    //         }
    //     }
    //     KeysMap.set(this, keys);
    //     return keys;
    // }
    // static get __all_patchkeys__() {

    //     // this is the child prototype
    //     var keys = PatchKeysMap.get(this);
    //     if(keys) return keys;

    //     keys = [];
    //     var kls = this;
    //     const mro = this.__mro__;

    //     for(var x = mro.length - 1; x >= 0; x--) {
    //         if(mro[x].hasOwnProperty('__patchkeys__')) {
    //             keys.push(...mro[x].__patchkeys__);
    //         }
    //     }
    //     PatchKeysMap.set(this, keys);
    //     return keys;
    // }
    static get __child_classes__() {
        return this.__meta__.children;
        // var children = ChildClassMap.get(this);
        // if(children) return children;
        // children = [];
        // ChildClassMap.set(this, children);
        // return children;
    }
    static __register__(...names) {
        if(names.length) {
            for(const name of names) this.__meta__.register(name);
        } else {
            // register with the default.
            this.__meta__.register();
        }
    }
    get __class__() {
        return this.constructor;
    }
    static get __parent__() {
        return this === Model ? null : Object.getPrototypeOf(this);
    }

    as_jsonable(contract='default') {
        return new FirInterop.FirSerializer(contract).as_jsonable(this, 'transport');
    }
    static create_from_jsonable(jsonable, contract='default') {
        return new FirInterop.FirSerializer(contract).create_from_jsonable(this, jsonable, 'transport');
    }
    // update_from_jsonable(jsonable, contract='default') {
    //     return new FirInterop.FirSerializer(contract, 'transport').create_from_jsonable(jsonable);
    // }
    static from_pojo(pojo, contract='default') {
        // overrides the default layer=null on FS.from_pojo because we're expecting
        // models here.
        return new FirInterop.FirSerializer(contract).from_pojo(pojo, 'transport');
    }
    static from_pojo_checked(pojo, contract='default') {
        var inst = new FirInterop.FirSerializer(contract).from_pojo(pojo, 'transport');
        if(inst !== null && (!(inst instanceof this))) {
            throw new Error(`${this.name}.from_pojo deserialized an unexpected type.`, {expected: this, inst: inst});
        }
        return inst;    
    }
    dumps(contract='default') {
        return new FirInterop.FirSerializer(contract).dumps(this, 'transport');
    }
    static dumps(inst, contract='default') {
        return new FirInterop.FirSerializer(contract).dumps(inst, 'transport');
    }
    static loads(json, contract='default') {
        return new FirInterop.FirSerializer(contract).loads(json, 'transport');
    }


    as_patch(contract='default') {
        return new FirInterop.FirSerializer(contract).as_patch(this);   
    }   

    apply_patch(patch, contract='default') {
        return new FirInterop.FirSerializer(contract).apply_patch(this, patch);   

    }

    static get_serializer(contract='default') {
        return new FirInterop.FirSerializer(contract);
    }

    sync_to_instance(from, contract='default') {
        return new FirInterop.FirSerializer(contract).sync_to_instance(this, from);
    }


    static __schema__ = {
        $pk: Number,
    }

  
}
Model.__register__();

FirInterop.Model = Model;
FirInterop.ModelRegistry = ModelRegistry;
/* Okay.

*/