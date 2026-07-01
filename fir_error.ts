export class FirError extends Error {
    constructor(message, context = {}) {
        // Automatically inject the context into the native cause slot
        super(message, { cause: context });
        
        this.name = "FirValidationError";
        this.field = context?.field;
        this.model = context?.model;
        this.__meta__ = context.__meta__ || context?.model?.__meta__;
    }

    // // Custom inspect hook for Node.js / Vitest terminal logging
    // [Symbol.for('nodejs.util.inspect.custom')]() {
    //     return `${this.name} [${this.modelName}.${this.fieldName}]: ${this.message}\n` +
    //            `Received: ${JSON.stringify(this.invalidValue, null, 2)}`;
    // }
}