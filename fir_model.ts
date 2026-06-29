import moment from 'moment';

const MroMap = new Map();
const KeysMap = new Map();
const PatchKeysMap = new Map();
export const ModelRegistry = new Map();
const ChildClassMap = new Map();



export class Model {

    constructor() {
        this.pk = null;
    }
    // get obs() {
    //     return this[ObsStoreSymbol];
    // }
    static get __mro__() {
        var mro = MroMap.get(this) || [];
        if(mro.length) return mro;
        
        var kls = this;
        var mro = [];
        while(kls && kls != Function.prototype) {
            mro.push(kls);
            kls = Object.getPrototypeOf(kls);
        }
        MroMap.set(this, mro);
        return mro;
    }
    static get __all_keys__() {

        // this is the child prototype
        var keys = KeysMap.get(this);
        if(keys) return keys;

        keys = [];
        var kls = this;
        const mro = this.__mro__;

        for(var x = mro.length - 1; x >= 0; x--) {
            if(mro[x].hasOwnProperty('__keys__')) {
                keys.push(...mro[x].__keys__);
            }
        }
        KeysMap.set(this, keys);
        return keys;
    }
    static get __all_patchkeys__() {

        // this is the child prototype
        var keys = PatchKeysMap.get(this);
        if(keys) return keys;

        keys = [];
        var kls = this;
        const mro = this.__mro__;

        for(var x = mro.length - 1; x >= 0; x--) {
            if(mro[x].hasOwnProperty('__patchkeys__')) {
                keys.push(...mro[x].__patchkeys__);
            }
        }
        PatchKeysMap.set(this, keys);
        return keys;
    }
    static get __child_classes__() {
        var children = ChildClassMap.get(this);
        if(children) return children;
        children = [];
        ChildClassMap.set(this, children);
        return children;
    }
    static __register__(name) {
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

    static to_plain_pojo(val) {
        if(val instanceof Model) {
            return val = val.as_jsonable();
        } else if(val && val.constructor === Date) {
            return {'__kls__': 'datetime', 'd': val.toISOString()};
        } else if(val && moment.isMoment(val)) {
            var date = val.toDate();
            if(!date) return null;
            return {'__kls__': 'datetime', 'd': val.toDate().toISOString()}
        } else if(val && val instanceof Array) {
            return val.map(Model.to_plain_pojo);                
        } else if(val instanceof Promise) {
            return undefined;
        } else if(val && typeof(val) == 'object') {
            var cleaned = {};
            for(const [subkey, subvalue] of Object.entries(val)) {
                cleaned[subkey] = Model.to_plain_pojo(subvalue);
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
    as_jsonable() {
        const keys = this.__class__.__all_keys__;
        const jsonable = {
            "__kls__": this.__class__.name,
        };

        for(var k of keys) {
            // console.log(k);
            var val = this[k];
            val = Model.to_plain_pojo(val);
            jsonable[k] = val;
        }
        return jsonable;
    }
    static from_pojo(pojo) {
        if(pojo instanceof Array) {
            return pojo.map(Model.from_pojo);
        } else if(pojo && typeof pojo === 'object') {
            const kls = pojo.__kls__;
            switch(kls) {
                case null:
                case undefined:
                    var rehydrated = {}
                    for(const [subkey, subvalue] of Object.entries(pojo)) {
                        rehydrated[subkey] = Model.from_pojo(subvalue);
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
                    return model.create_from_jsonable(pojo); 
            }
        } else {
            return pojo;
        }
    }
    static create_from_jsonable(jsonable) {
        var inst = new this();
        const keys = this.__all_keys__;
        for(const k of keys) {
            // try to assign them in key order, but skip any that
            // the json didn't specify.
            if(jsonable.hasOwnProperty(k)) {
                inst[k] = Model.from_pojo(jsonable[k])
            }
        }
        return inst;
    }
    dumps() {
        return JSON.stringify(this.as_jsonable());
    }
    static loads(json) {
        const jsonable = JSON.parse(json);
        return Model.from_pojo(jsonable);
    }
    clone() {
        return Model.loads(this.dumps());
    }

    static __keys__ = ['pk'];
    static __patchkeys__ = ['pk'];
}
Model.__register__();
