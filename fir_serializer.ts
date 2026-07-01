import {FirInterop} from './fir_interop';
import {FirError} from './fir_error';

import moment from 'moment';

// var TPK_INCREMENTER = 1;
// const TPK = Symbol.for('TPK');
const TPK = '__tpk__';
FirInterop.TPK = TPK;
FirInterop.TPK_INCREMENTER = 1;

export class FirSerializer {
    constructor(contract) {
        this.contract = contract;
        this.to_pojo_bound = this.to_pojo.bind(this);
        this.from_pojo_bound = this.from_pojo.bind(this);
    }


    to_pojo(val, layer=null) {
        if(val instanceof FirInterop.Model) {
            if(layer === null) {
                throw new Error(`Cannot deserialize ${val} of type ${val.__class__.__name__} without a layer (transport/patch) specified.`)
            }
            return val = this.as_jsonable(val, layer);
        } else if(val && val.constructor === Date) {
            return {'__kls__': 'datetime', 'd': val.toISOString()};
        } else if(val && moment.isMoment(val)) {
            var date = val.toDate();
            if(!date) return null;
            return {'__kls__': 'datetime', 'd': val.toDate().toISOString()}
        } else if(val && val instanceof Array) {
            return val.map(v=>this.to_pojo(v, layer));                
        } else if(val instanceof Promise) {
            return undefined;
        } else if(val && typeof(val) == 'object') {
            var cleaned = {};
            for(const [subkey, subvalue] of Object.entries(val)) {
                cleaned[subkey] = this.to_pojo(subvalue, layer);
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
    as_jsonable(inst, layer='transport') {
        // This can be called with layer transport or patch.
       
        const keys = inst.__class__.__meta__.contracts.get(this.contract)[layer].keys();
        // const keys = inst.__class__.__all_keys__;
        const jsonable = {
            "__kls__": inst.__class__.name,
        };
        if(layer == 'patch' && !inst.pk) {
            jsonable['__tpk__'] = inst[TPK];
        }
        
        for(var k of keys) {
            // console.log(k);
            var val = inst[k];
            val = this.to_pojo(val, layer);
            jsonable[k] = val;
        }
        return jsonable;
    }
    // neither from_pojo nor create_from_jsonable
    // need layer, because they are ALWAYS transport- they are specifically
    // rehydrating new objects, never mutating objects.
    // the problem here is that sometimes we want to run from_pojo in order to
    // rehydrated Decimals/datetimes on a patch.  the patch needs __kls__.
    // but *shouldn't* rehydrate models, specifically.  (at least, not by default.)
    from_pojo(pojo, layer=null) {
        if(pojo instanceof Array) {
            // this implicitly means that all arrays are always copied.
            return pojo.map(v=>this.from_pojo(v, layer));
        } else if(pojo && typeof pojo === 'object') {
            const kls = pojo.__kls__;
            if(kls === 'Decimal') {
                return Number(pojo.str) || null;
            } else if(kls === 'datetime') {
                return new moment(pojo.d) || null;                
            } else if(kls === null || kls === undefined || layer === null) {
                // treat it as a normal object if there's no kls
                // or if we have no contract layer.
                var rehydrated = {}
                for(const [subkey, subvalue] of Object.entries(pojo)) {
                    rehydrated[subkey] = this.from_pojo(subvalue, layer);
                }
                return rehydrated;

            } else {
                const model = FirInterop.ModelRegistry.get(kls);
                if(!model) {
                    console.error('Model registry keys are ', [...FirInterop.ModelRegistry.keys()]);
                    throw `Could not find a model for ${kls}, make sure it was registered.`;
                }
                return this.create_from_jsonable(model, pojo, layer); 
            }
        } else {
            return pojo;
        }
    }
    create_from_jsonable(model, jsonable, layer='transport') {
        // Nope: ~this does not need layer because it is always, always transport.~
        // sometimes we really do construct new objects in patch mode.
        var inst = new model();

        if(inst.__class__.__meta__.unresolved_schema) {
            throw new Error(`Cannot deserialize a ${this.name} while the schema is unresolved.`)
        }

        const contract_setters = inst.__class__.__meta__.contracts.get(this.contract)[layer];
        for(const [k, setter] of contract_setters) {
            // try to assign them in the data contract key order
            // (other members of jsonable are ignored)
            if(Object.hasOwn(jsonable, k)) {

                let val = this.from_pojo(jsonable[k], layer);
                // type safety check.
                setter(inst, val);
            }
        }
        return inst;
    }
    dumps(inst, layer='transport') {
        return JSON.stringify(this.as_jsonable(inst, layer));
    }
    loads(json, layer='transport') {
        // always transport?  Actually I suppose it's often patch.
        const jsonable = JSON.parse(json);
        return this.from_pojo(jsonable, layer);
    }
    clone() {
        return Model.loads(this.dumps());
    }

    as_patch(inst) {
        // always patch obviously
        return this.as_jsonable(inst, 'patch');
    }

    apply_patch(inst, patch) {
        // always patch obviously

        const contract_setters = inst.__class__.__meta__.contracts.get(this.contract).patch;
        const this_schema = inst.__class__.__meta__.schema;

        for(const [k, setter] of contract_setters) {
            // try to assign them in the data contract key order
            
            if(!Object.hasOwn(patch, k)) {
                // if the patch doesn't have it, skip it.
                continue;
            }
            // get the subpatch.
            let subpatch = patch[k];

            let def = this_schema.get(k);

            if(!def.is_model) {
                // if this field isn't a model field,
                // just set it safely, and move on.
                var val = this.from_pojo(patch[k], 'patch'); // but rehydrate it in patch mode.
                setter(inst, val);
                continue;
            }

            // current value on this instance.
            var current = inst[k];

            if(!def.is_array) {
                // single object.
                if(current 
                    && current.__class__ === FirInterop.ModelRegistry.get(subpatch.__kls__)
                    && (current.pk === null || current.pk === subpatch.pk)) {
                    // if the current object exists, is the right type,
                    // and has no pk or a matching pk, then reuse it.
                    this.apply_patch(current, subpatch);
                    continue;
                } else {
                    // otherwise we need a new object.  The old object
                    // can vanish.
                    var new_object = this.from_pojo(subpatch, 'patch');
                    setter(inst, new_object);
                    continue;
                }
            } else {
                if(!(subpatch instanceof Array)) {
                    throw new Error(`Cannot patch ${inst.__class__.name}.${k} to a non-array`);
                };
                // Map the subpatch items to the current items.
                let assoc = match_patch_list_to_instances(subpatch, current);

                // construct a new list of items
                var new_list = subpatch.map(subpatch_item=>{
                    // reuse items if we found a match.
                    var new_item = assoc.get(subpatch_item);
                    if(new_item) {
                        // apply the subpatch to the recycled item
                        this.apply_patch(new_item, subpatch_item);
                    } else {
                        // construct a new item for the subpatch, wholesale (but still in patch context)
                        new_item = this.from_pojo(subpatch_item, 'patch');
                    }
                    return new_item;
                });
                setter(inst, new_list);
            }

        }
        return inst;
    }
    sync_to_instance(target, source) {
        if(!(target instanceof FirInterop.Model)) {
            throw new FirError(`sync_to_instance target must be a fir.Model instance`, {target: target, source: source, contract: this.contract});
        }
        if(!(source instanceof FirInterop.Model)) {
            throw new FirError(`sync_to_instance source must be a fir.Model instance`, {target: target, source: source, contract: this.contract});
        }
        if(target.__class__ !== source.__class__) {
            throw new FirError(`sync_to_instance target and source must be instances of the same class`, {target: target, source: source, contract: this.contract});
        }

        const contract_setters = target.__class__.__meta__.contracts.get(this.contract).transport;
        const this_schema = target.__class__.__meta__.schema;

        for(const [k, setter] of contract_setters) {
            // try to assign them in the data contract key order
            
            if(!Object.hasOwn(source, k)) {
                // if the source doesn't have it (somehow?), skip it.
                continue;
            }
            // get the new value
            let fieldval = source[k];

            let def = this_schema.get(k);

            if(!def.is_model) {
                // if this field isn't a model field,
                // just set it safely, and move on.
                setter(target, fieldval);
                continue;
            }

            // current value on this instance.
            var current = target[k];

            if(!def.is_array) {
                // single object.
                if(current 
                    && current.__class__ === fieldval.__class__
                    && (current.pk === null || current.pk === fieldval.pk)) {
                    // if the current object exists, is the right type,
                    // and has no pk or a matching pk, then sync it.
                    this.sync_to_instance(current, fieldval);
                    continue;
                } else {
                    // otherwise just assign the new object from source.
                    setter(target, fieldval);
                    continue;
                }
            } else {
                if(!(fieldval instanceof Array)) { // somehow?
                    throw new FirError(`Cannot sync ${target.__class__.name}.${k} to a non-array`, {target, source, field:k, value:fieldval});
                };
                // Map the syncing items to the current items
                let assoc = match_instances(fieldval, current);

                // construct a new list of items
                var new_list = fieldval.map(sync_item=>{
                    // reuse items if we found a match.
                    var new_item = assoc.get(sync_item);
                    if(new_item) {
                        // apply the subpatch to the recycled item
                        this.sync_to_instance(new_item, sync_item);
                    } else {
                        // we couldn't find a match, so just use the sync item
                        new_item = sync_item;
                    }
                    return new_item;
                });
                setter(target, new_list);
            }

        }
        return target;

    }
}



class TwoDimensionalMap {
    #root = new Map();

    set(key1, key2, value) {
        let subMap = this.#root.get(key1);
        if (!subMap) {
            subMap = new Map();
            this.#root.set(key1, subMap);
        }
        subMap.set(key2, value);
        return this;
    }

    get(key1, key2) {
        const subMap = this.#root.get(key1);
        return subMap ? subMap.get(key2) : undefined;
    }

    has(key1, key2) {
        const subMap = this.#root.get(key1);
        return subMap ? subMap.has(key2) : false;
    }

    delete(key1, key2) {
        const subMap = this.#root.get(key1);
        if (!subMap) return false;
        const deleted = subMap.delete(key2);
        if (subMap.size === 0) {
            this.#root.delete(key1);
        }
        return deleted;
    }
}

function match_patch_list_to_instances(patches, instances) {
    // index existing instances by pk if they have one
    const kls_cache = new Map();
    for(var patch of patches) {
        if(!patch.__kls__) {
            throw new FirError("Cannot match a patch/sync object to a known class because it has no __kls__", {patch})
        }
        var cls = FirInterop.ModelRegistry.get(patch.__kls__);
        if(!cls) {
            throw new FirError("Cannot match a patch/sync object to a known class because __kls__ is unregistered", {patch})
        }
        kls_cache.set(patch.__kls__, cls);
    }

    const by_pk = new TwoDimensionalMap();

    instances.filter(i=>i.pk).forEach(i=>{by_pk.set(i.__class__ , i.pk, i)});

    // tpk is an ephemeral id created via as_patch on null-pk
    // objects, for cases where the backend is going to create a pk.
    // it's used to associate patches/syncs when the objects don't yet
    // have a backend-assigned pk.
    // index existing instances by tpk if they have one.
    const by_tpk = new TwoDimensionalMap();
    instances.filter(i=>(i.pk === null || i.pk === undefined) && i[TPK])
    .forEach(i=>{by_tpk.set(i.__class__, i[TPK], i)});

    // the mapping we're finding.
    const assoc = new Map();

    for(var patch of patches) {
        var pcls = kls_cache.get(patch.__kls__);
        var match = patch.pk ? by_pk.get(pcls, patch.pk) : null;
        if(!match && patch.__tpk__) {
            match = by_tpk.get(pcls, patch.__tpk__);
        }
        if(match) {
            // found a good match.
            assoc.set(patch, match);
        }
    }

    return assoc;
}

function match_instances(sync_items, current_instances) {
    // index existing instances by pk if they have one
    if(!sync_items.every(item=>item instanceof FirInterop.Model)) {
        throw new FirError('Cannot sync instance lists because the sync items are not all model instances.', {sync_items});
    }
    if(!(current_instances instanceof Array)) {
        throw new FirError('Cannot sync instance lists because the current items are not an array', {current_instances});
    }
    if(!current_instances.every(item=>item instanceof FirInterop.Model)) {
        throw new FirError('Cannot sync instance lists because the current items are not all model instances', {current_instances});
    }

    const by_pk = new TwoDimensionalMap();

    current_instances.filter(i=>i.pk).forEach(i=>{by_pk.set(i.__class__ , i.pk, i)});

    // tpk is an ephemeral id created via as_patch on null-pk
    // objects, for cases where the backend is going to create a pk.
    // it's used to associate patches/syncs when the objects don't yet
    // have a backend-assigned pk.
    // index existing current_instances by tpk if they have one.
    const by_tpk = new TwoDimensionalMap();
    current_instances.filter(i=>(i.pk === null || i.pk === undefined) && i[TPK])
    .forEach(i=>{by_tpk.set(i.__class__, i[TPK], i)});

    // the mapping we're finding.
    const assoc = new Map();

    for(var item of sync_items) {
        var pcls = item.__class__;
        var match = item.pk ? by_pk.get(pcls, item.pk) : null;
        if(!match && item[TPK]) {
            match = by_tpk.get(pcls, item[TPK]);
        }
        if(match) {
            // found a good match.
            assoc.set(item, match);
        }
    }

    return assoc;
}


FirInterop.FirSerializer = FirSerializer;


        // okay.  The tricky thing here is when we're setting
        // subpatches.  
        // technically, ONLY model instances can be patched like this.
        // what happens if a model patch is inside, say, an array.  Is that
        // allowed?  I think no.  Like, you can't apply a patch to a [Room],
        // because you can't *generate* a patch to a [Room], only a Room.
        // How else might we deeply-nest something where you ever needed to
        // "patch" a non-model?  I... can't think of a way?
        // so arrays are really the only thing, I think.

        // do we never ever serialize an object of models?  I feel like the
        // observableMap option (where it's really an indexed list) is perfectly
        // fine for that.

        // Okay.  So any OTHER object never chains, right?
        // what happens if that DID somehow get in?  I think it'd patch it
        // as an assignment, and it wouldn't get rehydrated, right?
        // Yeah.  Okay.


                // what are our options now?
                // single model instance, has matching/null pk: update that instance
                // single model instance, ours dne or has different pk: rehydrate the patch after all.

                // multi model array- for each, find a matching or null pk
                //                    (temp pk??)
                //                    if there's matching, patch that instance
                //                    else, rehydrate and push

                // so how do we know what we're inspecting?  I guess it's schema?
                // I don't feel like we should trust the patch here, right?
                // What if we didn't want to use schema?  Well then, I guess in
                // that case we rehydrate the patch directly?  In that case,
                // we'd have to use the transport layer, since we're not updating
                // a subpatch but creating fresh items... 
                // that must be wrong though, no?
                // I actually think we still use the patch context.  I think that
                // basically will rehydrate everything BUT the models, leaving
                // the __kls__ in place.  if that gets assigned weird, so be it
                // The difference is that sometimes we DO want to create objects
                // if patching a fresh object on.  



/*
    What happens if I loads() some payload and it ends up having a patch?
    You NEED to be contextually aware of whether that payload- or some part of it-
    are part of a patch or transport.

    I think that means you need to be really careful about whether you use
    JSON.parse or from_pojo/loads.  You can't just slap any payload in and
    trust that you're going to get the right thing back.

    How did the python side of this handle that?  How did it know to load it
    correctly?  I think because of concrete_class.  I don't think patches
    included their kls at all.  (should I switch to pkls?)

    I think loads_pojo is basically just from_pojo(patch).  It never hits
    model code that way.

    The point is, I think the payload needs to STAY unrehydrated until the
    very last second.
    Technically you COULD run it through loads_pojo to get dates/moments parsed
    in advance, that won't hurt.  But, it's going to double-process all that
    if you then later apply_patch or update from jsonable.

    That's making it smell a bit, where the patch layer is pulling double-duty
    in from_pojo.

    I'm actually thinking about making the from_pojo context use 'patch' by
    default.  That'd mean that by default it doesn't rehydrate.

    Kind of the issue here is that from_pojo might actually be the common entry
    point.

    Imagine I had a payload that arrived already as objects, ie from sockets 
    or any other transport layer that handled plain json.  That payload could
    have a mix of objects and patches, and isn't guaranteed to even be anything.
    Actually it's almost like... in that context... it has NO contract?
    Which feels like it should maybe be the default?

    The consumer has to know the shape of that payload, which I can't.  They're
    going to want to slap it naively into the deserializer to get 
    their dates worked out, but NOT to generate new model instances.

    Here's a thought- am I ever going to send an object with {kls} to from_pojo
    from apply_patch?  I don't think so, because rather I'd construct a new
    object right there and recurse apply_patch on it.
    * Except I may as WELL send that to from_pojo if I know I NEED a fresh created
      one.  if apply_patch can't find an instance to patch, then it may as well use
      from_pojo to construct one- that's semantically identical, no?
    * * Except if you're doing an apply_patch() hook.  Which doesn't even *exist*
        anymore.  You actually can't hook any of this anymore, uh oh.
        Though... from_pojo could call apply_patch instead of create_from_jsonable.

    Except yes, occasionally I would- if I KNEW whatever it was, wasn't a
    component, and it just got directly serialized as a raw object.
    - A named tuple, for instance.  That'd get done with layer patch,
    anyway, since I'm writing to it and ultimately it's part of the same patch
    graph, that makes sense.

    Okay, but that actually tracks the new theoretical semantics of from_pojo
    where a contract of NULL means "Don't rehydrate models at all," because I
    don't have a data contract.  prototype type checking should catch most
    naive errors here.

    So that makes default deserialization (from_pojo) do no contract rehydration.
    Model.loads_transport, loads_patch: would specify the layer.
    Model.from_pojo: still null layer?  No, I think this is transport?

    I wonder if these helper methods on model are wearing out their welcome.
    Starting to feel like maybe you just want to grab a FirSerializer.

    What are the things we want to do?
    1. Load a big chunk of json from somewhere, probably as like a page-load
    2. Demystify primitives from a large object graph.
        - I think this wants FirSerializer.from_pojo.
        - notably because you are NOT expecting to get Models.
    3. Completely rehydrate a large object graph because it's probably not
       a mix of transport/patch.
        - I think it makes sense to expect pojos back.  So I think you cuold
        - safely have Model.from_pojo specify transport by default.
    4. 


I like that, but let's try a different angle.
I have a pojo.  What is it?
1. Mixed, unknown- a page load.  Some might be patch, but most likely it's
    all transport
    Must use FS.from_pojo(layer=null)
2. Known transport-only.  It came out of as_jsonable/to_pojo.
    May use Model.from_pojo/Model.loads.  Internally uses FS.from_pojo(layer=transport)
3. Known patch-only.  We know we're not rehydrating directly, but we might when
    applying a patch.
    Must use instance/FS.apply_patch.  Must NOT use Model.loads/Model.from_pojo,
    or otherwise be loaded from FS.

I have an object graph and want to make a patch.
Well, it must be a model instance, period.  No arrays.
It effectively just uses apply_patch.
    Sometimes it assigns directly; other times, it uses create_from_jsonable

Convenience methods- I think these strictly do the layer stuff we expect.
If you want to serialize differently, get a serializer.

Can you patch arbitrary shapes?  Like coordinates that aren't a model.

No.  You can't patch anything you don't have a contract for.



*/