import './AgentCard.css';

const PersonIcon = () => (
  <svg  viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M30 30C37.1797 30 43 24.1797 43 17C43 9.8203 37.1797 4 30 4C22.8203 4 17 9.8203 17 17C17 24.1797 22.8203 30 30 30ZM30 37C20.3359 37 1 41.8359 1 51.5V56H59V51.5C59 41.8359 39.6641 37 30 37Z" fill="#666666"/>
  </svg>
);

function AgentCard({ agent, onClick }) {
  return (
    <div className="agent-card" onClick={() => onClick && onClick(agent)}>
      <div className="agent-info">
        <div className="agent-avatar">
          <PersonIcon className="avatar-icon" />
          
        </div>
        <div className="agent-details">
          <h3 className="agent-name">{agent.name}</h3>
          <p className="agent-contact">Contact ID: {agent.contactId}</p>
          <p className="agent-program">Program: {Array.isArray(agent.programs) && agent.programs.length > 0 ? agent.programs.join(', ') : 'No programs assigned'}</p>
          <p className="agent-cases">Total Cases: {agent.totalCases}</p>
        </div>
      </div>
    </div>
  );
}

export default AgentCard;