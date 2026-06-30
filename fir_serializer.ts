import {FirInterop} from './fir_interop';
import moment from 'moment';

export class FirSerializer {
    constructor(contract, layer) {
        this.contract = contract;
        this.layer = layer;
        this.to_pojo_bound = this.to_pojo.bind(this);
        this.from_pojo_bound = this.from_pojo.bind(this);
    }


    to_pojo(val) {
        if(val instanceof FirInterop.Model) {
            return val = this.as_jsonable(val);
        } else if(val && val.constructor === Date) {
            return {'__kls__': 'datetime', 'd': val.toISOString()};
        } else if(val && moment.isMoment(val)) {
            var date = val.toDate();
            if(!date) return null;
            return {'__kls__': 'datetime', 'd': val.toDate().toISOString()}
        } else if(val && val instanceof Array) {
            return val.map(this.to_pojo_bound);                
        } else if(val instanceof Promise) {
            return undefined;
        } else if(val && typeof(val) == 'object') {
            var cleaned = {};
            for(const [subkey, subvalue] of Object.entries(val)) {
                cleaned[subkey] = this.to_pojo(subvalue);
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
    as_jsonable(inst) {
        // layer = layer || 'transport';
        const keys = inst.__class__.__meta__.contracts.get(this.contract)[this.layer].keys();
        // const keys = inst.__class__.__all_keys__;
        const jsonable = {
            "__kls__": inst.__class__.name,
        };

        for(var k of keys) {
            // console.log(k);
            var val = inst[k];
            val = this.to_pojo(val);
            jsonable[k] = val;
        }
        return jsonable;
    }
    from_pojo(pojo) {
        if(pojo instanceof Array) {
            // this implicitly means that all arrays are always copied.
            return pojo.map(this.from_pojo_bound);
        } else if(pojo && typeof pojo === 'object') {
            const kls = pojo.__kls__;
            switch(kls) {
                case null:
                case undefined:
                    // and here, all {} objects are always copied.
                    var rehydrated = {}
                    for(const [subkey, subvalue] of Object.entries(pojo)) {
                        rehydrated[subkey] = this.from_pojo(subvalue);
                    }
                    return rehydrated;
                case 'Decimal':
                    return Number(pojo.str) || null;
                case 'datetime':
                    return new moment(pojo.d) || null;
                default:
                    const model = FirInterop.ModelRegistry.get(kls);
                    if(!model) {
                        console.error('Model registry keys are ', [...FirInterop.ModelRegistry.keys()]);
                        throw `Could not find a model for ${kls}, make sure it was registered.`;
                    }
                    return this.create_from_jsonable(model, pojo); 
            }
        } else {
            return pojo;
        }
    }
    create_from_jsonable(model, jsonable) {
        var inst = new model();
        // console.log("About to update an instance of ", inst.__class__.name);
        this.update_from_jsonable(inst, jsonable);
        return inst;
    }
    update_from_jsonable(inst, jsonable) {
        // var inst = new this();


        if(inst.__class__.__meta__.unresolved_schema) {
            throw new Error(`Cannot deserialize a ${this.name} while the schema is unresolved.`)
        }

        const contract_setters = inst.__class__.__meta__.contracts.get(this.contract)[this.layer];
        for(const [k, setter] of contract_setters) {
            // try to assign them in the data contract key order
            // (other members of jsonable are ignored)
            if(Object.hasOwn(jsonable, k)) {

                let val = this.from_pojo(jsonable[k]);
                // type safety check.
                setter(inst, val);
            }
        }
        return inst;
    }
    dumps(inst) {
        return JSON.stringify(this.as_jsonable(inst));
    }
    loads(json) {
        const jsonable = JSON.parse(json);
        return this.from_pojo(jsonable);
    }
    clone() {
        return Model.loads(this.dumps());
    }

    as_patch() {
        
    }
}

FirInterop.FirSerializer = FirSerializer;
