/**
 * Copyright (c) 2022 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { Mat4 } from '../../mol-math/linear-algebra/3d/mat4';
import { getMatrices, operatorGroupsProvider } from '../../mol-model-formats/structure/property/assembly';
import { Structure, Trajectory } from '../../mol-model/structure';
import { Assembly } from '../../mol-model/structure/model/properties/symmetry';
import { PluginStateObject as SO, PluginStateTransform } from '../../mol-plugin-state/objects';
import { Task } from '../../mol-task';
import { Column, Table } from '../../mol-data/db';
import { mmCIF_Schema } from '../../mol-io/reader/cif/schema/mmcif';
import { MmcifFormat } from '../../mol-model-formats/structure/mmcif';
import { arrayFind } from '../../mol-data/util';
import { StateAction, StateObject } from '../../mol-state';
import { CifField } from '../../mol-io/reader/cif';
import { ParamDefinition as PD } from '../../mol-util/param-definition';
import { PluginContext } from '../../mol-plugin/context';
import { getFileInfo } from '../../mol-util/file-info';
import { PetworldPreset } from './preset';
import { MmcifProvider } from '../../mol-plugin-state/formats/trajectory';

const plus1 = (v: number) => v + 1, minus1 = (v: number) => v - 1;

export { StructureFromPetworld };
type StructureFromPetworld = typeof StructureFromPetworld
const StructureFromPetworld = PluginStateTransform.BuiltIn({
    name: 'structure-from-petworld',
    display: { name: 'Structure from PetWorld', description: 'Create a molecular structure from PetWorld models.' },
    from: SO.Molecule.Trajectory,
    to: SO.Molecule.Structure,
    params: a => {
        if (!a) {
            return { modelIndex: PD.Numeric(0, {}, { description: 'Zero-based index of the model', immediateUpdate: true }) };
        }
        return { modelIndex: PD.Converted(plus1, minus1, PD.Numeric(1, { min: 1, max: a.data.frameCount, step: 1 }, { description: 'Model Index', immediateUpdate: true })) };
    }
})({
    apply({ a, params }) {
        return Task.create('Build Structure', async ctx => {
            const s = await buildModelsAssembly(a.data, '1', params.modelIndex).runInContext(ctx);
            if (!s) return StateObject.Null;

            const props = { label: s.model.label, description: Structure.elementDescription(s) };
            return new SO.Molecule.Structure(s, props);
        });
    },
    dispose({ b }) {
        b?.data.customPropertyDescriptors.dispose();
    }
});

function buildModelsAssembly(trajectory: Trajectory, asmName: string, modelIndex: number) {
    return Task.create('Build Models Assembly', async ctx => {
        const model = await Task.resolveInContext(trajectory.getFrameAtIndex(modelIndex), ctx);
        if (!MmcifFormat.is(model.sourceData)) return;

        const { db, frame } = model.sourceData.data;
        const pdbx_model = frame.categories.pdbx_model.getField('name')!;
        const PDB_model_num = frame.categories.pdbx_struct_assembly_gen.getField('PDB_model_num')!;

        // hack to use model name as entity description
        const label = pdbx_model.str(modelIndex);
        (model as any).label = label;
        model.entities.data = {
            ...model.entities.data,
            pdbx_description: Column.asArrayColumn(model.entities.data.pdbx_description),
        };
        const entityIds = model.atomicHierarchy.chains.label_entity_id.toArray();
        for (let i = 0, il = entityIds.length; i < il; ++i) {
            const idx = model.entities.getEntityIndex(entityIds[i]);
            (model.entities.data.pdbx_description.__array as any)[idx] = [label];
        }

        // hack to cache models assemblies
        if (!(trajectory as any).__modelsAssemblies) {
            (trajectory as any).__modelsAssemblies = createModelsAssemblies(db.pdbx_struct_assembly, db.pdbx_struct_assembly_gen as StructAssemblyGen, db.pdbx_struct_oper_list, PDB_model_num);
        }
        const modelsAssemblies = (trajectory as any).__modelsAssemblies as ModelsAssembly[];

        const modelsAssembly = arrayFind(modelsAssemblies, ma => ma.assembly.id.toLowerCase() === asmName);
        if (!modelsAssembly) throw new Error(`Models Assembly '${asmName}' is not defined.`);

        const { assembly } = modelsAssembly;
        const assembler = Structure.Builder();
        const g = assembly.operatorGroups[modelIndex];

        const structure = Structure.ofModel(model);
        const { units } = structure;

        for (const oper of g.operators) {
            for (const unit of units) {
                assembler.addWithOperator(unit, oper);
            }
        }

        return assembler.getStructure();
    });
}

//

type StructAssembly = Table<mmCIF_Schema['pdbx_struct_assembly']>
type StructAssemblyGen = Table<mmCIF_Schema['pdbx_struct_assembly_gen']>
type StructOperList = Table<mmCIF_Schema['pdbx_struct_oper_list']>

type ModelsAssembly = { assembly: Assembly, modelNums: number[] };

function createModelsAssemblies(pdbx_struct_assembly: StructAssembly, pdbx_struct_assembly_gen: StructAssemblyGen, pdbx_struct_oper_list: StructOperList, PDB_model_num: CifField): ReadonlyArray<ModelsAssembly> {
    if (!pdbx_struct_assembly._rowCount) return [];

    const matrices = getMatrices(pdbx_struct_oper_list);
    const assemblies: ModelsAssembly[] = [];
    for (let i = 0; i < pdbx_struct_assembly._rowCount; i++) {
        assemblies[assemblies.length] = createModelsAssembly(pdbx_struct_assembly, pdbx_struct_assembly_gen, i, matrices, PDB_model_num);
    }
    return assemblies;
}

type Matrices = Map<string, Mat4>
type Generator = { assemblyId: string, expression: string, asymIds: string[] }

function createModelsAssembly(pdbx_struct_assembly: StructAssembly, pdbx_struct_assembly_gen: StructAssemblyGen, index: number, matrices: Matrices, PDB_model_num: CifField): ModelsAssembly {
    const id = pdbx_struct_assembly.id.value(index);
    const details = pdbx_struct_assembly.details.value(index);
    const generators: Generator[] = [];
    const modelNums: number[] = [];

    const { assembly_id, oper_expression, asym_id_list } = pdbx_struct_assembly_gen;

    for (let i = 0, _i = pdbx_struct_assembly_gen._rowCount; i < _i; i++) {
        if (assembly_id.value(i) !== id) continue;
        generators[generators.length] = {
            assemblyId: id,
            expression: oper_expression.value(i),
            asymIds: asym_id_list.value(i)
        };
        modelNums[modelNums.length] = PDB_model_num.int(i);
    }

    const assembly = Assembly.create(id, details, operatorGroupsProvider(generators, matrices));

    return { assembly, modelNums };
}

export const LoadPetworldModel = StateAction.build({
    display: { name: 'Load Petworld', description: 'Open or download a model' },
    params: {
        cif: PD.File({ accept: '.cif,.bcif', description: 'Petworld-style cif file.', label: 'Petworld CIF' }),
    },
    from: SO.Root
})(({ params }, ctx: PluginContext) => Task.create('Petworld Loader', async taskCtx => {
    if (params.cif === null) {
        ctx.log.error('No file selected');
        return;
    }
    const file = params.cif;

    const info = getFileInfo(file.file!);
    const isBinary = ctx.dataFormats.binaryExtensions.has(info.ext);
    const { data } = await ctx.builders.data.readFile({ file, isBinary });
    const parsed = await MmcifProvider.parse(ctx, data);
    await ctx.builders.structure.hierarchy.applyPreset(parsed.trajectory, PetworldPreset);
}));
