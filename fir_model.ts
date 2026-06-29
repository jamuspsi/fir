import moment from 'moment';

const MroMap = new Map();
const KeysMap = new Map();
const PatchKeysMap = new Map();
export const ModelRegistry = new Map();
const ChildClassMap = new Map();

const MetaSymbol = Symbol('ModelMeta');

export class ModelMeta {
    model : Model;
    constructor(model:Model) {
        this.model = model;
        this.children = [];
        this.parent = null;
        if(model !== Model) {
            this.parent = Object.getPrototypeOf(model)
            // console.log("Adding ", model.name, " to ", parent.name )
            this.parent.__meta__.children.push(model);
        }
        if(this.parent) {
            this.mro = [...this.parent.__meta__.mro, model]
        } else {
            this.mro = [model];
        }

        this.contracts = new Map();
        this.parse_contracts();

        // this.mro = this.calculate_mro();
    }
    parse_contracts() {
        this.contract_recipes = new Map(); // name->['key', '$key', '-key', '*import']

        // recipes are first copied from the parent
        if(this.parent) {
            for(var [name, fields] of this.parent.__meta__.contract_recipes) {
                this.contract_recipes.set(name, [...fields]);
            }
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
        const parse_recipe = (name, recipe)=>{
            const contract = {
                transport: new Set(),
                patch: new Set(),
            };
            for(var token of recipe) {
                if(token.startsWith('$')) {
                    contract.transport.add(token.substring(1));
                    contract.patch.add(token.substring(1));
                } else if(token.startsWith('-')) {
                    contract.transport.delete(token.substring(1));
                    contract.patch.delete(token.substring(1));
                } else {
                    contract.transport.add(token);
                }
            }
            contract.transport = [...contract.transport];
            contract.patch = [...contract.patch];

            this.contracts.set(name, contract);
            // processing.pop();

        }
        for(var [name, recipe] of expanded_recipes) {
            parse_recipe(name, recipe);
        }

    }
}


export class Model {

    constructor() {
        this.pk = null;
    }
    // get obs() {
    //     return this[ObsStoreSymbol];
    // }
    static get __meta__() {

        if(!Object.hasOwn(this, MetaSymbol)) {
            this[MetaSymbol] = new ModelMeta(this);
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
    static __register__(name) {
        this.__meta__;

        name = name === undefined ? this.name : name;
        if(name) {
            if(ModelRegistry.has(name)) {
                console.warn(`${name} is being re-registered in the Model class registry.`)
            }
            ModelRegistry.set(name, this);
        }
        if(this !== Model) {
            var childset = Object.getPrototypeOf(this).__child_classes__;
            if(!childset.includes(this)) {
                childset.push(this);
            }
        }

        if (typeof window !== 'undefined' && import.meta.env.DEV) {
            if (name) window[name] = this;    
        }
    }
    get __class__() {
        return this.constructor;
    }
    static get __parent__() {
        return this === Model ? null : Object.getPrototypeOf(this);
    }

    static to_plain_pojo(contract, val) {
        if(val instanceof Model) {
            return val = val.as_jsonable(contract);
        } else if(val && val.constructor === Date) {
            return {'__kls__': 'datetime', 'd': val.toISOString()};
        } else if(val && moment.isMoment(val)) {
            var date = val.toDate();
            if(!date) return null;
            return {'__kls__': 'datetime', 'd': val.toDate().toISOString()}
        } else if(val && val instanceof Array) {
            return val.map(x=>Model.to_plain_pojo(contract, x));                
        } else if(val instanceof Promise) {
            return undefined;
        } else if(val && typeof(val) == 'object') {
            var cleaned = {};
            for(const [subkey, subvalue] of Object.entries(val)) {
                cleaned[subkey] = Model.to_plain_pojo(contract, subvalue);
            }
            return cleaned;
        } else if(typeof(val) === 'number' && (val % 1 || val > 2**31-1 || val < -(2**31))) {
            return {'__kls__': 'Decimal', 'str': val.toString()};
        } else if(Number.isNaN(val)) {
            return null;
        } else {
            return val;
        }
    }
    as_jsonable(contract) {
        const keys = this.__class__.__meta__.contracts.get(contract).transport;
        // const keys = this.__class__.__all_keys__;
        const jsonable = {
            "__kls__": this.__class__.name,
        };

        for(var k of keys) {
            // console.log(k);
            var val = this[k];
            val = Model.to_plain_pojo(contract, val);
            jsonable[k] = val;
        }
        return jsonable;
    }
    static from_pojo(contract, pojo) {
        if(pojo instanceof Array) {
            return pojo.map(sub_pojo=>Model.from_pojo(contract, sub_pojo));
        } else if(pojo && typeof pojo === 'object') {
            const kls = pojo.__kls__;
            switch(kls) {
                case null:
                case undefined:
                    var rehydrated = {}
                    for(const [subkey, subvalue] of Object.entries(pojo)) {
                        rehydrated[subkey] = Model.from_pojo(contract, subvalue);
                    }
                    return rehydrated;
                case 'Decimal':
                    return Number(pojo.str) || null;
                case 'datetime':
                    return new moment(pojo.d) || null;
                default:
                    const model = ModelRegistry.get(kls);
                    if(!model) {
                        console.error('Model registry keys are ', [...ModelRegistry.keys()]);
                        throw `Could not find a model for ${kls}, make sure it was registered.`;
                    }
                    return model.create_from_jsonable(contract, pojo); 
            }
        } else {
            return pojo;
        }
    }
    static create_from_jsonable(contract, jsonable) {
        var inst = new this();
        const keys = this.__meta__.contracts.get(contract).transport;

        for(const k of keys) {
            // try to assign them in key order, but skip any that
            // the json didn't specify.
            if(Object.hasOwn(jsonable, k)) {
                inst[k] = Model.from_pojo(contract, jsonable[k])
            }
        }
        return inst;
    }
    dumps(contract) {
        return JSON.stringify(this.as_jsonable(contract));
    }
    static loads(contract, json) {
        const jsonable = JSON.parse(json);
        return Model.from_pojo(contract, jsonable);
    }
    clone() {
        return Model.loads(this.dumps());
    }

    static __keys__ = ['pk'];
    static __patchkeys__ = ['pk'];

    static __contracts__ = {
        default: ['$pk'],
    }
}
Model.__register__();


/* Okay.

*/