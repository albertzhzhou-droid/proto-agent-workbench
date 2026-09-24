/** Scientific worker protocol. The host owns persistence and process cancellation. */
export type ChemScienceOperatorId =
  | 'simulate_reaction_network' | 'scan_reaction_temperature' | 'fit_reaction_rates'
  | 'simulate_reversible_chain' | 'simulate_catalytic_cycle' | 'simulate_cstr' | 'simulate_pfr' | 'simulate_semibatch'
  | 'analyze_reaction_sensitivity' | 'analyze_reaction_flux' | 'propagate_reaction_uncertainty'
  | 'simulate_nonisothermal_batch' | 'simulate_nonisothermal_cstr' | 'simulate_tanks_in_series'
  | 'simulate_catalyst_deactivation' | 'simulate_gas_liquid_reaction' | 'simulate_catalyst_pellet'
  | 'simulate_photochemical_isomerization' | 'simulate_excited_state_quenching' | 'simulate_cyclic_voltammetry' | 'simulate_chronoamperometry'
  | 'fit_arrhenius_eyring' | 'compare_integrated_rate_laws'
  | 'simulate_stochastic_network' | 'simulate_axial_dispersion' | 'analyze_tracer_rtd'
  | 'simulate_rtd_segregation' | 'analyze_network_structure' | 'scan_cstr_steady_states'
  | 'analyze_molecule' | 'compare_molecules' | 'inspect_reaction_smiles' | 'parse_xyz_trajectory'
  | 'simulate_competitive_adsorption' | 'simulate_langmuir_hinshelwood' | 'simulate_eley_rideal' | 'simulate_electrode_step' | 'simulate_diffusion_film'
  | 'organic_candidates' | 'inorganic_candidates' | 'simulate_interface'
  | 'summarize_replicates' | 'compare_assay_groups' | 'fit_calibration_curve' | 'analyze_spectrum' | 'chemical_pca'
  | 'fit_adsorption_isotherm' | 'analyze_vanthoff_equilibrium' | 'calculate_acid_base_speciation' | 'fit_electrochemical_impedance'
  | 'prepare_molecular_dataset' | 'search_substructures' | 'cluster_molecules' | 'formula_properties' | 'balance_equation' | 'solution_calculator';

export interface ChemScienceOperator {
  id: ChemScienceOperatorId;
  title: string;
  description: string;
  category: 'kinetics' | 'molecules' | 'materials' | 'interfaces' | 'trajectories' | 'analysis' | 'statistics' | 'chemical-data';
  workspace: 'analysis' | 'statistics' | 'chemical-data';
  input_schema: Record<string, unknown>;
  example_input: Record<string, unknown>;
  available: boolean;
  unavailable_reason?: string;
  source: string;
}
export interface ChemMolecule {
  smiles: string;
  formula: string;
  atoms: Array<{element: string; x: number; y: number; z: number; map_number?: number}>;
  bonds: Array<{start: number; end: number; order: number}>;
  composition: Record<string, number>;
  formal_charge: number;
  descriptors: Record<string, number>;
  geometry_method: string;
  geometry_status: string;
}
export interface ChemReactionSpecies {
  id: string;
  label?: string;
  smiles?: string;
  initial_concentration: number;
  composition?: Record<string, number>;
  formal_charge?: number;
}
export interface ChemReaction {
  id: string;
  reactants: Record<string, number>;
  products: Record<string, number>;
  rate_constant: number;
  activation_energy_j_mol?: number;
  reference_temperature_k?: number;
}
export interface ChemReactionNetwork {
  label?: string;
  species: ChemReactionSpecies[];
  reactions: ChemReaction[];
  provenance?: string;
}
export interface ChemSimulationInput {
  example?: 'reversible' | 'consecutive' | 'parallel' | 'catalytic' | 'interface';
  network?: ChemReactionNetwork;
  duration_s?: number;
  points?: number;
  temperature_k?: number;
}
export interface ChemSimulationResult {
  network: ChemReactionNetwork;
  time_s: number[];
  temperature_k: number;
  series: Array<{id: string; label: string; concentration: number[]; conversion: Array<number | null>; molecule?: ChemMolecule}>;
  reaction_rates: Array<{id: string; rate: number[]; effective_rate_constant: number; rate_constant_unit: string}>;
  conservation: {
    chemically_balanced: boolean | null;
    element_balance: Array<{element: string; values: number[]; max_absolute_drift: number; max_relative_drift: number}>;
    invariants: Array<{weights: Record<string, number>; values: number[]; max_absolute_drift: number}>;
    stoichiometric_residuals: Array<{reaction: string; element: string; residual: number}>;
    minimum_raw_concentration: number;
  };
  scene: {kind: 'population-based'; description: string; frames: Array<{time_s: number; populations: Record<string, number>}>};
  method: {solver: string; rtol: number; atol: number; nfev: number; model: string; concentration_unit: string};
  warnings: string[];
}
export interface ChemScienceCatalog {
  version: string;
  operators: ChemScienceOperator[];
  examples: Array<{id: string; title: string; input: ChemSimulationInput}>;
  runtime: Record<string, string | boolean>;
}
export interface ChemScienceWorkerResponse {
  ok: boolean;
  operator: string;
  result?: Record<string, unknown>;
  error?: {code: string; message: string; details?: unknown};
  provenance: {worker_version: string; input_sha256: string; result_sha256?: string; dependencies: Record<string, string>; source_sha256: string; source_files_sha256?: Record<string,string>};
}
